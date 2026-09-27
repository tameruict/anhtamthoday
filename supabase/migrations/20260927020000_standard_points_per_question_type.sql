-- Điểm mỗi câu ở luồng "làm đề trực tiếp" (ngân hàng đề thi) đang bị chia đều
-- 10 điểm cho MỌI câu bất kể loại (multiple_choice/true_false/short_answer),
-- ra các số lẻ xấu (0.37, 0.36, 0.39...) và còn SAI VỀ BẢN CHẤT: câu Đúng/Sai
-- (4 ý, chấm bậc thang 0.10/0.25/0.50/1.00 theo số ý đúng) bị gán ngang bằng
-- câu trắc nghiệm thường thay vì trọng số cao hơn hẳn (tối đa 1.00đ) như đúng
-- cấu trúc đề thi tốt nghiệp THPT từ 2025 của Bộ GDĐT.
--
-- Sửa bằng cách gán điểm theo ĐÚNG thang điểm chuẩn đã dùng cho luồng phòng
-- thi cũ (xem exam_blueprint_sections seed ở
-- 20260603124025_exam_system_2026_blueprints_part_5.sql):
--   - Phần I  (multiple_choice): 0.25đ/câu
--   - Phần II (true_false)     : tối đa 1.00đ/câu — score_exam_session() đã
--     có sẵn công thức bậc thang 0.10/0.25/0.50/1.00 theo số ý đúng khi câu
--     có đúng 4 ý (nhánh fallback BGD 2025), nên chỉ cần max_points=1.00 là
--     ăn khớp ngay, không cần sửa gì ở hàm chấm.
--   - Phần III (short_answer)  : 0.50đ/câu với Toán, 0.25đ/câu với các môn
--     còn lại (Lý/Hoá/Sinh/...), đúng như blueprint chuẩn.
--
-- Với đề đúng cấu trúc chuẩn (18 MC + 4 TF + 6 SA, hoặc 12+4+6 với Toán) tổng
-- vẫn ra đúng 10.00 tự nhiên (không cần ép). Đề bị thiếu câu do OCR (hiếm)
-- sẽ ra tổng < 10 — phản ánh đúng thực tế thiếu dữ liệu thay vì che giấu
-- bằng cách chia lại điểm cho đều.

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
