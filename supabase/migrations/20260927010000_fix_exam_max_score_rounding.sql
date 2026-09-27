-- Điểm tối đa hiển thị lệch 10 (9.99 hoặc 10.08 thay vì 10.00) ở luồng "làm đề
-- trực tiếp" (ngân hàng đề thi + VIP).
--
-- Nguyên nhân: start_exam_session() chia đều 10 điểm cho N câu bằng
-- round(10.0/N, 4), nhưng cột exam_session_questions.max_points là
-- numeric(5,2) (chỉ 2 chữ số thập phân) -> giá trị bị làm tròn thêm lần nữa
-- khi lưu. Tổng N giá trị đã làm tròn 2 chữ số không còn bằng 10.00 nữa
-- (27 câu * 0.37 = 9.99; 28 câu * 0.36 = 10.08). max_score sau đó được tính
-- lại bằng SUM(max_points) nên kế thừa luôn sai số này.
--
-- Sửa bằng cách chia theo "xu" (1000 xu = 10.00đ): mỗi câu nhận
-- floor(1000/N) xu, phần dư (1000 mod N) xu được rải đều 1 xu/câu cho N câu
-- đầu tiên (theo thứ tự hiển thị) -> tổng luôn đúng 1000 xu = 10.00, chênh
-- lệch giữa 2 câu bất kỳ tối đa 0.01đ (tương đương cách chia điểm truyền
-- thống khi 10 không chia hết cho số câu).

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
  v_base_cents integer;
  v_extra_cents integer;
  total_max_score numeric;
  v_active_session uuid;
  v_active_exam uuid;
begin
  if student_id is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  -- 1) Đóng các phiên đã quá hạn để không chặn học sinh vĩnh viễn.
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

  -- 2) Nếu còn phiên đang hoạt động: cùng đề -> resume; khác đề -> chặn.
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

  -- Đếm đúng số câu sẽ được insert bên dưới (cùng điều kiện lọc) để mẫu số
  -- luôn khớp với số dòng thực tế, không dựa vào exams.question_count có thể
  -- lệch nếu có câu bị xoá mềm.
  select count(*) into v_question_count
  from public.questions q
  where q.exam_id = p_exam_id
    and q.deleted_at is null;

  if coalesce(v_question_count, 0) < 1 then
    raise exception 'EXAM_HAS_NO_QUESTIONS';
  end if;

  v_base_cents := 1000 / v_question_count;
  v_extra_cents := 1000 % v_question_count;

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
    (v_base_cents + case when ordered.display_seq <= v_extra_cents then 1 else 0 end) / 100.0
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
