-- Hướng dẫn giải (question_solutions.explanation) được ghi đúng lúc import OCR
-- nhưng chưa từng tới được UI: get_session_review_core_20260821 (RPC đứng sau
-- public.get_session_review, dùng ở trang /result) không join question_solutions
-- nên payload trả về không có field này ở bất kỳ đâu.
--
-- Đồng thời private.has_solution_access() chỉ kiểm tra entitlements.kind =
-- 'solution_access', nhưng fulfill_purchase_order() (20260926063824) chỉ từng
-- cấp kind = 'vip_subscription' cho các gói VIP-1M/4M/1Y — không gói nào từng
-- ghi 'solution_access' cả. Nghĩa là ngay cả khi RPC có join, cổng VIP vẫn luôn
-- đóng với mọi user. Theo đúng thiết kế ở KE_HOACH_DE_THI_V2_EXAM_FIRST.md §5/§11
-- (VIP = gộp cả unlimited lượt + full tính năng, bao gồm lời giải), sửa luôn
-- has_solution_access để coi 'vip_subscription' còn hạn cũng là có quyền xem.

create or replace function private.has_solution_access(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user_id is not null and exists (
    select 1
    from public.entitlements entitlement
    where entitlement.user_id = p_user_id
      and entitlement.kind in ('solution_access', 'vip_subscription')
      and entitlement.revoked_at is null
      and (entitlement.expires_at is null or entitlement.expires_at > now())
  );
$$;

-- get_active_exam_session_full (đang làm bài) CỐ Ý không đổi: đường thi không
-- bao giờ được chạm question_solutions, kể cả với VIP.
CREATE OR REPLACE FUNCTION public.get_session_review_core_20260821(p_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_student uuid;
  v_status text;
  v_score numeric;
  v_due timestamptz;
  v_duration integer;
  v_room_deleted_at timestamptz;
  v_caller uuid := (select auth.uid());
  v_now timestamptz := now();
  v_has_solution_access boolean;
  v_result jsonb;
begin
  select
    session.student_id,
    session.status::text,
    session.score,
    session.due_at,
    coalesce(room.duration_minutes, exam.duration_minutes),
    room.deleted_at
  into v_student, v_status, v_score, v_due, v_duration, v_room_deleted_at
  from public.exam_sessions session
  left join public.exam_rooms room on room.id = session.exam_room_id
  left join public.exams exam on exam.id = session.exam_id
  where session.id = p_session_id;

  if v_student is null then
    raise exception 'SESSION_NOT_FOUND';
  end if;

  if v_caller is null
     or (v_caller <> v_student and not private.is_admin()) then
    raise exception 'PERMISSION_DENIED';
  end if;

  if v_status = 'in_progress' then
    if coalesce(v_due, v_now) <= v_now then
      update public.exam_sessions
      set status = 'submitted',
          submitted_at = coalesce(v_due, v_now),
          client_info = client_info ||
            jsonb_build_object('finalized', 'auto_expired'),
          updated_at = v_now
      where id = p_session_id;
      v_status := 'submitted';
    else
      raise exception 'SESSION_NOT_ENDED';
    end if;
  end if;

  if v_status = 'submitted' and v_score is null then
    perform public.score_exam_session(p_session_id);
  end if;

  -- Quyền xem lời giải tính theo chủ phiên (người đã thi), không theo người
  -- xem (admin xem hộ vẫn thấy nhờ private.is_admin() ở dưới).
  v_has_solution_access := private.has_solution_access(v_student) or private.is_admin();

  select jsonb_build_object(
    'session', (
      select jsonb_build_object(
        'id', session.id,
        'status', session.status,
        'attempt_number', session.attempt_number,
        'started_at', session.started_at,
        'submitted_at', session.submitted_at,
        'due_at', session.due_at,
        'scored_at', session.scored_at,
        'score', session.score,
        'max_score', session.max_score,
        'exam_room_id', session.exam_room_id,
        'room_name', coalesce(room.name, exam.title),
        'room_code', coalesce(room.code, exam.code),
        'room_deleted', room.deleted_at is not null,
        'duration_minutes', coalesce(room.duration_minutes, exam.duration_minutes),
        'subject_code', coalesce(room.subject_code, exam.subject_code),
        'subject_name', subject.name,
        'blueprint_code', blueprint.code,
        'blueprint_name', blueprint.name
      )
      from public.exam_sessions session
      left join public.exam_rooms room on room.id = session.exam_room_id
      left join public.exams exam on exam.id = session.exam_id
      left join public.subjects subject on subject.code = coalesce(room.subject_code, exam.subject_code)
      left join public.exam_blueprints blueprint
        on blueprint.id = room.blueprint_id
      where session.id = p_session_id
    ),
    'questions', case
      when v_room_deleted_at is not null then '[]'::jsonb
      else coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', session_question.id,
            'question_seq', session_question.question_seq,
            'display_no', coalesce(
              session_question.display_no,
              session_question.question_seq::text
            ),
            'max_points', session_question.max_points,
            'question_id', question.id,
            'code', question.code,
            'type', question.type,
            'content', question.content,
            'image_url', question.image_url,
            'image_alt_text', coalesce(
              nullif(trim(question.image_alt_text), ''),
              (
                select nullif(trim(registry.alt_text), '')
                from public.r2_assets registry
                where registry.public_url = question.image_url
                limit 1
              ),
              (
                select nullif(trim(asset.alt_text), '')
                from public.question_assets asset
                where asset.question_id = question.id
                  and asset.kind = 'image'
                  and (question.image_url is null or asset.url = question.image_url)
                order by asset.display_order
                limit 1
              )
            ),
            'options', coalesce((
              select jsonb_agg(
                jsonb_build_object(
                  'id', option.id,
                  'seq', option.seq,
                  'label', option.label,
                  'content', option.content,
                  'image_url', option.image_url,
                  'image_alt_text', option.image_alt_text,
                  'correct', exists(
                    select 1
                    from public.question_correct_options correct
                    where correct.question_id = question.id
                      and correct.option_id = option.id
                  )
                ) order by option.seq
              )
              from public.question_options option
              where option.question_id = question.id
            ), '[]'::jsonb),
            'true_false_items', coalesce((
              select jsonb_agg(
                jsonb_build_object(
                  'id', item.id,
                  'seq', item.seq,
                  'label', item.label,
                  'content', item.content,
                  'correct_value', (
                    select answer.correct_value
                    from public.question_true_false_answer_keys answer
                    where answer.question_id = question.id
                      and answer.item_id = item.id
                  )
                ) order by item.seq
              )
              from public.question_true_false_items item
              where item.question_id = question.id
            ), '[]'::jsonb),
            'short_answer_keys', coalesce((
              select jsonb_agg(
                jsonb_build_object(
                  'display', coalesce(
                    answer.display_value,
                    answer.normalized_text,
                    answer.numeric_value::text
                  ),
                  'answer_type', answer.answer_type
                ) order by answer.is_primary desc nulls last
              )
              from public.question_short_answer_keys answer
              where answer.question_id = question.id
            ), '[]'::jsonb),
            'explanation', case
              when v_has_solution_access then solution.explanation
              else null
            end,
            'solution_locked', (
              nullif(btrim(solution.explanation), '') is not null
              and not v_has_solution_access
            ),
            'answer', (
              select jsonb_build_object(
                'answer_json', answer.answer_json,
                'selected_option_id', answer.selected_option_id,
                'short_answer_text', answer.short_answer_text,
                'is_correct', answer.is_correct,
                'earned_points', answer.earned_points
              )
              from public.session_answers answer
              where answer.session_question_id = session_question.id
                and answer.student_id = v_student
              limit 1
            )
          ) order by session_question.question_seq
        )
        from public.exam_session_questions session_question
        join public.questions question
          on question.id = session_question.question_id
        left join public.question_solutions solution
          on solution.question_id = question.id
        where session_question.session_id = p_session_id
      ), '[]'::jsonb)
    end
  ) into v_result;

  return v_result;
end;
$function$;
