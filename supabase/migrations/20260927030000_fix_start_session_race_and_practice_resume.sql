-- Fix tiep: "Khong the bat dau bai thi. Vui long thu lai."
--
-- Hai lo hong con lai (xem memory one-active-session-constraint):
--
-- 1) start_practice_session KHONG co buoc auto-expire + resume/block nhu 3 ham
--    con lai (join_exam, start_free_exam_session, start_exam_session). No chi
--    "exists (...) -> raise SESSION_ALREADY_ACTIVE" mot cach vo dieu kien, va
--    khong set due_at khi insert nen khong the tu resume dung phong khi hoc
--    sinh reload trang. Dong bo lai dung pattern.
--
-- 2) Ca 4 ham deu co khoang ho TOCTOU giua buoc "SELECT kiem tra phien active"
--    va "INSERT phien moi": neu 2 request chay gan nhu dong thoi (double-click,
--    double-tap tren mobile, tab cu chua kip dong), ca hai co the cung vuot qua
--    buoc kiem tra roi cung INSERT, va chi muc unique rieng phan
--    uq_exam_sessions_one_active_per_student bat loi tho SQLSTATE 23505
--    "duplicate key value violates unique constraint" - loi nay khong nam
--    trong tap ma loi nghiep vu nen UI hien thi thong bao mac dinh. Da xac nhan
--    loi nay THUC SU xay ra tren log postgres cua project (khi test lai
--    start_exam_session truoc ban vá 2026-09-26). Boc INSERT trong
--    EXCEPTION WHEN unique_violation va chuyen thanh 'SESSION_ALREADY_ACTIVE'
--    de dong lai khoang ho nay o ca 4 ham, thay vi de lo tho ro ri ra UI.

create or replace function public.join_exam(p_code text, p_subject_code text default null::text, p_exam_room_id uuid default null::uuid, p_device_hash text default null::text)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $function$
#variable_conflict use_variable
declare
  key_record record;
  session_id uuid;
  student_id uuid;
  subject_code text;
  requested_room_id uuid;
  room_id uuid;
  room_subject_code text;
  paper_id uuid;
  now_at timestamptz := now();
  v_duration integer;
  v_active_session uuid;
  v_active_room uuid;
  room_ready boolean;
  room_readiness_reason text;
begin
  student_id := (select auth.uid());
  if student_id is null then raise exception 'NOT_AUTHENTICATED'; end if;

  insert into public.students (id, full_name)
  select pr.id, pr.full_name from public.profiles pr where pr.id = student_id
  on conflict (id) do nothing;

  if nullif(trim(p_code), '') is null then raise exception 'KEY_NOT_FOUND'; end if;

  subject_code := nullif(upper(trim(p_subject_code)), '');
  requested_room_id := p_exam_room_id;

  select key.id, key.assigned_to, key.total_attempts, key.used_attempts, key.status,
         key.expires_at
  into key_record from public.exam_keys key
  where key.code = upper(trim(p_code)) for update;

  if not found then raise exception 'KEY_NOT_FOUND'; end if;
  if key_record.status not in ('unused', 'active') then raise exception 'KEY_INVALID_STATUS'; end if;
  if key_record.expires_at is not null and key_record.expires_at < now_at then raise exception 'KEY_EXPIRED'; end if;
  -- Bind key vao tai khoan: key da gan cho HS khac thi tu choi.
  if key_record.assigned_to is not null and key_record.assigned_to <> student_id then
    raise exception 'KEY_ASSIGNED_TO_OTHER';
  end if;
  if key_record.used_attempts >= key_record.total_attempts then raise exception 'KEY_NO_ATTEMPTS_LEFT'; end if;

  if requested_room_id is not null then
    select room.id, room.subject_code, room.duration_minutes, readiness.is_ready, readiness.readiness_reason
    into room_id, room_subject_code, v_duration, room_ready, room_readiness_reason
    from public.exam_rooms room
    join public.v_exam_room_readiness readiness on readiness.id = room.id
    where room.id = requested_room_id and room.status = 'published'
      and (room.starts_at is null or room.starts_at <= now_at)
      and (room.ends_at is null or room.ends_at > now_at);
  else
    if subject_code is null then raise exception 'SUBJECT_REQUIRED'; end if;
    select room.id, room.subject_code, room.duration_minutes, readiness.is_ready, readiness.readiness_reason
    into room_id, room_subject_code, v_duration, room_ready, room_readiness_reason
    from public.exam_rooms room
    join public.v_exam_room_readiness readiness on readiness.id = room.id
    where room.subject_code = subject_code and room.status = 'published'
      and (room.starts_at is null or room.starts_at <= now_at)
      and (room.ends_at is null or room.ends_at > now_at)
    order by room.published_at desc nulls last, room.created_at desc limit 1;
  end if;

  if room_id is null then raise exception 'ROOM_NOT_AVAILABLE'; end if;
  if not coalesce(room_ready, false) then
    if room_readiness_reason = 'question_content_needs_review' then raise exception 'QUESTION_CONTENT_NEEDS_REVIEW'; end if;
    raise exception 'ROOM_NOT_READY';
  end if;
  if subject_code is not null and room_subject_code <> subject_code then raise exception 'KEY_SUBJECT_MISMATCH'; end if;

  update public.exam_sessions as s
  set status = 'submitted',
      submitted_at = coalesce(s.due_at, s.started_at + make_interval(mins => rm.duration_minutes)),
      grading_status = 'pending_auto', grading_error = null,
      client_info = s.client_info || jsonb_build_object('finalized', 'auto_expired'),
      updated_at = now_at
  from public.exam_rooms rm
  where s.student_id = student_id and s.status = 'in_progress' and rm.id = s.exam_room_id
    and coalesce(s.due_at, s.started_at + make_interval(mins => rm.duration_minutes)) <= now_at;

  select s.id, s.exam_room_id into v_active_session, v_active_room
  from public.exam_sessions s where s.student_id = student_id and s.status = 'in_progress'
  order by s.started_at desc limit 1;

  if v_active_session is not null then
    if v_active_room = room_id then return v_active_session;
    else raise exception 'SESSION_ALREADY_ACTIVE'; end if;
  end if;

  select paper.id into paper_id from public.exam_room_papers paper
  where paper.exam_room_id = room_id and paper.status = 'published'
  order by paper.is_default desc, paper.display_order, paper.created_at limit 1;
  if paper_id is null then raise exception 'PAPER_NOT_AVAILABLE'; end if;
  if not exists (select 1 from public.exam_room_questions placement where placement.paper_id = paper_id) then
    raise exception 'PAPER_HAS_NO_QUESTIONS';
  end if;

  update public.exam_keys
  set assigned_to = student_id,
      used_attempts = used_attempts + 1,
      status = case when used_attempts + 1 >= total_attempts then 'exhausted'::public.exam_key_status else 'active'::public.exam_key_status end,
      activated_at = coalesce(activated_at, now_at), updated_at = now_at
  where id = key_record.id;

  begin
    insert into public.exam_sessions (key_id, student_id, exam_room_id, paper_id, attempt_number, status, started_at, due_at)
    values (key_record.id, student_id, room_id, paper_id, key_record.used_attempts + 1, 'in_progress', now_at,
            now_at + make_interval(mins => coalesce(v_duration, 50)))
    returning id into session_id;
  exception when unique_violation then
    raise exception 'SESSION_ALREADY_ACTIVE';
  end;

  update public.exam_sessions
  set shuffle_config = jsonb_build_object('version', 1, 'seed', session_id::text, 'shuffleQuestions', 'within_difficulty', 'shuffleOptions', true)
  where id = session_id;

  insert into public.exam_session_questions (session_id, blueprint_section_id, question_id, question_seq, display_no, option_order, max_points)
  with placements as (
    select placement.blueprint_section_id, placement.question_id, placement.points_override,
           section.seq as section_seq, section.max_points_per_question,
           question.type as question_type, question.difficulty,
           md5(session_id::text || ':' || placement.blueprint_section_id::text || ':' || question.difficulty::text || ':' || placement.question_id::text) as tie_breaker
    from public.exam_room_questions placement
    join public.exam_blueprint_sections section on section.id = placement.blueprint_section_id
    join public.questions question on question.id = placement.question_id
    where placement.paper_id = paper_id
  ),
  ordered as (
    select placements.*, row_number() over (order by placements.section_seq, placements.difficulty, placements.tie_breaker) as display_seq
    from placements
  )
  select session_id, ordered.blueprint_section_id, ordered.question_id, ordered.display_seq, ordered.display_seq::text,
    case when ordered.question_type = 'multiple_choice' then coalesce((
      select array_agg(option_row.id order by option_row.sort_key)::uuid[] from (
        select option.id, case when count(*) over () = 4 and not private.has_option_self_reference(ordered.question_id)
          then md5(session_id::text || ':' || ordered.question_id::text || ':' || option.id::text)
          else lpad(option.seq::text, 4, '0') end as sort_key
        from public.question_options option where option.question_id = ordered.question_id
      ) option_row), '{}'::uuid[])
    else '{}'::uuid[] end,
    coalesce(ordered.points_override, ordered.max_points_per_question)
  from ordered order by ordered.display_seq;

  update public.students set current_key_id = key_record.id, updated_at = now_at
  where id = student_id and current_key_id is null;

  return session_id;
end;
$function$;

create or replace function public.start_free_exam_session(
  p_subject_code text default null::text,
  p_exam_room_id uuid default null::uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
#variable_conflict use_variable
declare
  attempt_number integer;
  session_id uuid;
  student_id uuid;
  subject_code text;
  requested_room_id uuid;
  room_id uuid;
  room_subject_code text;
  paper_id uuid;
  now_at timestamptz := now();
  v_duration integer;
  v_active_session uuid;
  v_active_room uuid;
  room_ready boolean;
  room_readiness_reason text;
  v_free_quota integer := 0;
  v_free_used integer := 0;
  v_charge_key_id uuid;
  v_charge_source text;
begin
  student_id := (select auth.uid());

  if student_id is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  insert into public.students (id, full_name)
  select pr.id, pr.full_name
  from public.profiles pr
  where pr.id = student_id
  on conflict (id) do nothing;

  subject_code := nullif(upper(trim(p_subject_code)), '');
  requested_room_id := p_exam_room_id;

  if requested_room_id is not null then
    select
      room.id, room.subject_code, room.duration_minutes,
      readiness.is_ready, readiness.readiness_reason
      into room_id, room_subject_code, v_duration, room_ready, room_readiness_reason
    from public.exam_rooms room
    join public.v_exam_room_readiness readiness on readiness.id = room.id
    where room.id = requested_room_id
      and room.mode = 'exam'
      and room.status = 'published'
      and (room.starts_at is null or room.starts_at <= now_at)
      and (room.ends_at is null or room.ends_at > now_at);
  else
    if subject_code is null then
      raise exception 'SUBJECT_REQUIRED';
    end if;

    select
      room.id, room.subject_code, room.duration_minutes,
      readiness.is_ready, readiness.readiness_reason
      into room_id, room_subject_code, v_duration, room_ready, room_readiness_reason
    from public.exam_rooms room
    join public.v_exam_room_readiness readiness on readiness.id = room.id
    where room.subject_code = subject_code
      and room.mode = 'exam'
      and room.status = 'published'
      and (room.starts_at is null or room.starts_at <= now_at)
      and (room.ends_at is null or room.ends_at > now_at)
    order by room.published_at desc nulls last, room.created_at desc
    limit 1;
  end if;

  if room_id is null then
    raise exception 'ROOM_NOT_AVAILABLE';
  end if;

  if not coalesce(room_ready, false) then
    if room_readiness_reason = 'question_content_needs_review' then
      raise exception 'QUESTION_CONTENT_NEEDS_REVIEW';
    end if;
    raise exception 'ROOM_NOT_READY';
  end if;

  if subject_code is not null and room_subject_code <> subject_code then
    raise exception 'SUBJECT_MISMATCH';
  end if;

  update public.exam_sessions as s
  set status = 'submitted',
      submitted_at = coalesce(
        s.due_at,
        s.started_at + make_interval(mins => rm.duration_minutes)
      ),
      grading_status = 'pending_auto',
      grading_error = null,
      client_info = s.client_info || jsonb_build_object('finalized', 'auto_expired'),
      updated_at = now_at
  from public.exam_rooms rm
  where s.student_id = student_id
    and s.status = 'in_progress'
    and rm.id = s.exam_room_id
    and coalesce(
      s.due_at,
      s.started_at + make_interval(mins => rm.duration_minutes)
    ) <= now_at;

  select s.id, s.exam_room_id
    into v_active_session, v_active_room
  from public.exam_sessions s
  where s.student_id = student_id
    and s.status = 'in_progress'
  order by s.started_at desc
  limit 1;

  if v_active_session is not null then
    if v_active_room = room_id then
      return v_active_session;
    else
      raise exception 'SESSION_ALREADY_ACTIVE';
    end if;
  end if;

  select coalesce(s.free_exam_quota, 0), coalesce(s.free_exam_used, 0)
    into v_free_quota, v_free_used
  from public.students s
  where s.id = student_id
  for update;

  if v_free_quota - v_free_used > 0 then
    v_charge_source := 'free';
  else
    select k.id into v_charge_key_id
    from public.exam_keys k
    where k.assigned_to = student_id
      and k.deleted_at is null
      and k.status in ('unused', 'active')
      and k.used_attempts < k.total_attempts
      and (k.expires_at is null or k.expires_at > now_at)
    order by k.expires_at nulls last, k.created_at
    limit 1
    for update skip locked;

    if v_charge_key_id is null then
      raise exception 'NO_ATTEMPTS_REMAINING';
    end if;
    v_charge_source := 'key';
  end if;

  select paper.id
    into paper_id
  from public.exam_room_papers paper
  where paper.exam_room_id = room_id
    and paper.status = 'published'
  order by paper.is_default desc, paper.display_order, paper.created_at
  limit 1;

  if paper_id is null then
    raise exception 'PAPER_NOT_AVAILABLE';
  end if;

  if not exists (
    select 1
    from public.exam_room_questions placement
    where placement.paper_id = paper_id
  ) then
    raise exception 'PAPER_HAS_NO_QUESTIONS';
  end if;

  select coalesce(max(s.attempt_number), 0) + 1
    into attempt_number
  from public.exam_sessions s
  where s.student_id = student_id
    and s.exam_room_id = room_id;

  begin
    insert into public.exam_sessions (
      key_id, student_id, exam_room_id, paper_id, attempt_number,
      status, started_at, due_at
    )
    values (
      v_charge_key_id, student_id, room_id, paper_id, attempt_number,
      'in_progress', now_at, now_at + make_interval(mins => coalesce(v_duration, 50))
    )
    returning id into session_id;
  exception when unique_violation then
    raise exception 'SESSION_ALREADY_ACTIVE';
  end;

  if v_charge_source = 'free' then
    update public.students
    set free_exam_used = free_exam_used + 1, updated_at = now_at
    where id = student_id;
  else
    update public.exam_keys
    set used_attempts = used_attempts + 1,
        status = case
          when used_attempts + 1 >= total_attempts then 'exhausted'::public.exam_key_status
          else 'active'::public.exam_key_status end,
        activated_at = coalesce(activated_at, now_at),
        updated_at = now_at
    where id = v_charge_key_id;

    insert into public.exam_key_usage_ledger (
      key_id, student_id, session_id, attempts, reason, idempotency_key
    ) values (
      v_charge_key_id, student_id, session_id, 1, 'exam',
      'free_flow:' || session_id::text
    )
    on conflict (idempotency_key) do nothing;
  end if;

  update public.exam_sessions
  set shuffle_config = jsonb_build_object(
    'version', 1,
    'seed', session_id::text,
    'shuffleQuestions', 'within_difficulty',
    'shuffleOptions', true
  )
  where id = session_id;

  insert into public.exam_session_questions (
    session_id, blueprint_section_id, question_id, question_seq,
    display_no, option_order, max_points
  )
  with placements as (
    select
      placement.blueprint_section_id,
      placement.question_id,
      placement.points_override,
      section.seq as section_seq,
      section.max_points_per_question,
      question.type as question_type,
      question.difficulty,
      md5(
        session_id::text || ':' ||
        placement.blueprint_section_id::text || ':' ||
        question.difficulty::text || ':' ||
        placement.question_id::text
      ) as tie_breaker
    from public.exam_room_questions placement
    join public.exam_blueprint_sections section
      on section.id = placement.blueprint_section_id
    join public.questions question
      on question.id = placement.question_id
    where placement.paper_id = paper_id
  ),
  ordered as (
    select
      placements.*,
      row_number() over (
        order by
          placements.section_seq,
          placements.difficulty,
          placements.tie_breaker
      ) as display_seq
    from placements
  )
  select
    session_id,
    ordered.blueprint_section_id,
    ordered.question_id,
    ordered.display_seq,
    ordered.display_seq::text,
    case
      when ordered.question_type = 'multiple_choice' then coalesce(
        (
          select array_agg(option_row.id order by option_row.sort_key)::uuid[]
          from (
            select
              option.id,
              case
                when count(*) over () = 4
                  and not private.has_option_self_reference(ordered.question_id)
                then md5(
                  session_id::text || ':' ||
                  ordered.question_id::text || ':' ||
                  option.id::text
                )
                else lpad(option.seq::text, 4, '0')
              end as sort_key
            from public.question_options option
            where option.question_id = ordered.question_id
          ) option_row
        ),
        '{}'::uuid[]
      )
      else '{}'::uuid[]
    end,
    coalesce(ordered.points_override, ordered.max_points_per_question)
  from ordered
  order by ordered.display_seq;

  update public.exam_sessions
  set client_info = jsonb_build_object('flow', 'free_exam', 'charge_source', v_charge_source)
  where id = session_id;

  return session_id;
end;
$function$;

create or replace function public.start_exam_session(p_exam_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
#variable_conflict use_variable
declare
  student_id uuid := (select auth.uid());
  exam_row public.exams%rowtype;
  session_id uuid;
  attempt_number integer;
  now_at timestamptz := now();
  is_vip boolean := false;
  v_question_count integer;
  v_sa_points numeric;
  total_max_score numeric;
  v_active_session uuid;
  v_active_exam uuid;
begin
  if student_id is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  update public.exam_sessions s
  set status = 'submitted',
      submitted_at = coalesce(s.submitted_at, s.due_at, now_at),
      grading_status = 'pending_auto',
      client_info = coalesce(s.client_info, '{}'::jsonb)
        || jsonb_build_object('finalized', 'auto_expired'),
      updated_at = now_at
  where s.student_id = student_id
    and s.status = 'in_progress'
    and s.due_at is not null
    and s.due_at <= now_at;

  select s.id, s.exam_id
    into v_active_session, v_active_exam
  from public.exam_sessions s
  where s.student_id = student_id
    and s.status = 'in_progress'
  order by s.started_at desc
  limit 1;

  if v_active_session is not null then
    if v_active_exam is not distinct from p_exam_id then
      return jsonb_build_object('session_id', v_active_session);
    else
      raise exception 'SESSION_ALREADY_ACTIVE';
    end if;
  end if;

  select * into exam_row
  from public.exams
  where id = p_exam_id
    and status = 'published';

  if not found then
    raise exception 'EXAM_NOT_AVAILABLE';
  end if;

  if not exam_row.is_free then
    select exists (
      select 1
      from public.entitlements e
      where e.user_id = student_id
        and e.kind = 'vip_subscription'
        and e.revoked_at is null
        and e.expires_at > now_at
    ) into is_vip;

    if not is_vip then
      raise exception 'UPGRADE_REQUIRED';
    end if;
  end if;

  insert into public.students (id, full_name)
  select pr.id, pr.full_name
  from public.profiles pr
  where pr.id = student_id
  on conflict (id) do nothing;

  select coalesce(max(s.attempt_number), 0) + 1
    into attempt_number
  from public.exam_sessions s
  where s.student_id = student_id
    and s.exam_id = p_exam_id;

  select count(*) into v_question_count
  from public.questions q
  where q.exam_id = p_exam_id
    and q.deleted_at is null;

  if coalesce(v_question_count, 0) < 1 then
    raise exception 'EXAM_HAS_NO_QUESTIONS';
  end if;

  v_sa_points := case when exam_row.subject_code = 'MATH' then 0.50 else 0.25 end;

  begin
    insert into public.exam_sessions (
      student_id, exam_id, exam_room_id, key_id, paper_id, attempt_number,
      status, started_at, due_at, max_score,
      shuffle_config, client_info
    )
    values (
      student_id, p_exam_id, null, null, null, attempt_number,
      'in_progress', now_at, now_at + make_interval(mins => exam_row.duration_minutes),
      10.00,
      jsonb_build_object(
        'version', 1,
        'seed', null,
        'shuffleQuestions', 'none',
        'shuffleOptions', true
      ),
      jsonb_build_object('flow', 'direct_exam')
    )
    returning id into session_id;
  exception when unique_violation then
    raise exception 'SESSION_ALREADY_ACTIVE';
  end;

  update public.exam_sessions
  set shuffle_config = jsonb_set(shuffle_config, '{seed}', to_jsonb(session_id::text))
  where id = session_id;

  insert into public.exam_session_questions (
    session_id, blueprint_section_id, question_id, question_seq,
    display_no, option_order, max_points
  )
  with ordered as (
    select
      q.id as question_id,
      q.type as question_type,
      row_number() over (order by q.part, q.order_in_exam) as display_seq
    from public.questions q
    where q.exam_id = p_exam_id
      and q.deleted_at is null
  )
  select
    session_id,
    null,
    ordered.question_id,
    ordered.display_seq,
    ordered.display_seq::text,
    case
      when ordered.question_type = 'multiple_choice' then coalesce(
        (
          select array_agg(option_row.id order by option_row.sort_key)::uuid[]
          from (
            select
              option.id,
              case
                when count(*) over () = 4
                  and not private.has_option_self_reference(ordered.question_id)
                then md5(
                  session_id::text || ':' ||
                  ordered.question_id::text || ':' ||
                  option.id::text
                )
                else lpad(option.seq::text, 4, '0')
              end as sort_key
            from public.question_options option
            where option.question_id = ordered.question_id
          ) option_row
        ),
        '{}'::uuid[]
      )
      else '{}'::uuid[]
    end,
    case ordered.question_type
      when 'multiple_choice' then 0.25
      when 'true_false' then 1.00
      when 'short_answer' then v_sa_points
      else round(10.0 / v_question_count, 2)
    end
  from ordered
  order by ordered.display_seq;

  select sum(sq.max_points) into total_max_score
  from public.exam_session_questions sq
  where sq.session_id = session_id;

  update public.exam_sessions
  set max_score = coalesce(total_max_score, 10.00)
  where id = session_id;

  return jsonb_build_object('session_id', session_id);
end;
$function$;

create or replace function public.start_practice_session(
  p_subject_code text,
  p_question_count integer default 20,
  p_knowledge_field_ids bigint[] default null,
  p_difficulties smallint[] default null
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
#variable_conflict use_variable
declare
  student_id uuid := (select auth.uid());
  subject_code text := nullif(upper(trim(p_subject_code)), '');
  requested_count integer := least(greatest(coalesce(p_question_count, 20), 5), 50);
  practice_room_id uuid;
  practice_blueprint_id uuid;
  session_id uuid := extensions.gen_random_uuid();
  attempt_number integer;
  selected_count integer;
  now_at timestamptz := now();
  v_duration integer;
  v_active_session uuid;
  v_active_room uuid;
begin
  if student_id is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  if subject_code is null then
    raise exception 'SUBJECT_REQUIRED';
  end if;

  select room.id, room.blueprint_id, room.duration_minutes
    into practice_room_id, practice_blueprint_id, v_duration
  from public.exam_rooms room
  join public.subjects subject on subject.code = room.subject_code
  join public.v_exam_room_readiness readiness on readiness.id = room.id
  where room.subject_code = subject_code
    and room.mode = 'practice'
    and readiness.is_ready
  order by room.published_at desc nulls last
  limit 1;

  if practice_room_id is null then
    raise exception 'PRACTICE_NOT_AVAILABLE';
  end if;

  -- Dong bo voi join_exam / start_free_exam_session / start_exam_session:
  -- tu dong ket thuc phien qua han roi moi quyet dinh resume (cung phong) hay
  -- chan (khac phong), thay vi raise SESSION_ALREADY_ACTIVE vo dieu kien.
  update public.exam_sessions as s
  set status = 'submitted',
      submitted_at = coalesce(
        s.due_at,
        s.started_at + make_interval(mins => rm.duration_minutes)
      ),
      grading_status = 'pending_auto',
      client_info = coalesce(s.client_info, '{}'::jsonb) || jsonb_build_object('finalized', 'auto_expired'),
      updated_at = now_at
  from public.exam_rooms rm
  where s.student_id = student_id
    and s.status = 'in_progress'
    and rm.id = s.exam_room_id
    and coalesce(
      s.due_at,
      s.started_at + make_interval(mins => rm.duration_minutes)
    ) <= now_at;

  select s.id, s.exam_room_id
    into v_active_session, v_active_room
  from public.exam_sessions s
  where s.student_id = student_id
    and s.status = 'in_progress'
  order by s.started_at desc
  limit 1;

  if v_active_session is not null then
    if v_active_room = practice_room_id then
      return v_active_session;
    else
      raise exception 'SESSION_ALREADY_ACTIVE';
    end if;
  end if;

  insert into public.students (id, full_name)
  select profile.id, profile.full_name
  from public.profiles profile
  where profile.id = student_id
  on conflict (id) do nothing;

  -- Practice is free: no key balance checks or deductions.

  select coalesce(max(session.attempt_number), 0) + 1
    into attempt_number
  from public.exam_sessions session
  where session.student_id = student_id
    and session.exam_room_id = practice_room_id;

  perform set_config('app.session_start_flow', 'practice', true);

  begin
    insert into public.exam_sessions (
      id,
      key_id,
      student_id,
      exam_room_id,
      paper_id,
      attempt_number,
      status,
      due_at,
      grading_status,
      client_info,
      shuffle_config
    ) values (
      session_id,
      null,
      student_id,
      practice_room_id,
      null,
      attempt_number,
      'in_progress',
      now_at + make_interval(mins => coalesce(v_duration, 50)),
      'pending_auto',
      jsonb_build_object('flow', 'practice'),
      jsonb_build_object(
        'version', 2,
        'seed', session_id::text,
        'shuffleQuestions', 'server_random',
        'shuffleOptions', true,
        'filters', jsonb_build_object(
          'knowledgeFieldIds', to_jsonb(p_knowledge_field_ids),
          'difficulties', to_jsonb(p_difficulties)
        )
      )
    );
  exception when unique_violation then
    raise exception 'SESSION_ALREADY_ACTIVE';
  end;

  insert into public.exam_session_questions (
    session_id,
    blueprint_section_id,
    question_id,
    question_seq,
    display_no,
    option_order,
    max_points
  )
  with selected as (
    select
      question.id as question_id,
      question.type as question_type,
      section.id as section_id,
      section.max_points_per_question as max_points
    from public.questions question
    join lateral (
      select blueprint_section.id, blueprint_section.max_points_per_question
      from public.exam_blueprint_sections blueprint_section
      where blueprint_section.blueprint_id = practice_blueprint_id
        and blueprint_section.question_type = question.type
      order by blueprint_section.seq
      limit 1
    ) section on true
    where question.subject_code = subject_code
      and question.status = 'approved'
      and question.content_quality_status <> 'needs_review'
      and question.deleted_at is null
      and (
        p_knowledge_field_ids is null
        or cardinality(p_knowledge_field_ids) = 0
        or question.knowledge_field_id = any(p_knowledge_field_ids)
      )
      and (
        p_difficulties is null
        or cardinality(p_difficulties) = 0
        or question.difficulty = any(p_difficulties)
      )
    order by random()
    limit requested_count
  ),
  numbered as (
    select selected.*, row_number() over ()::integer as sequence_number
    from selected
  )
  select
    session_id,
    numbered.section_id,
    numbered.question_id,
    numbered.sequence_number,
    numbered.sequence_number::text,
    case
      when numbered.question_type = 'multiple_choice' then coalesce((
        select array_agg(option.id order by md5(
          session_id::text || ':' || numbered.question_id::text || ':' || option.id::text
        ))::uuid[]
        from public.question_options option
        where option.question_id = numbered.question_id
      ), '{}'::uuid[])
      else '{}'::uuid[]
    end,
    numbered.max_points
  from numbered;

  get diagnostics selected_count = row_count;
  if selected_count <> requested_count then
    raise exception 'INSUFFICIENT_APPROVED_QUESTIONS';
  end if;

  update public.exam_sessions
  set max_score = (
    select sum(session_question.max_points)
    from public.exam_session_questions session_question
    where session_question.session_id = session_id
  )
  where id = session_id;

  return session_id;
end;
$$;
