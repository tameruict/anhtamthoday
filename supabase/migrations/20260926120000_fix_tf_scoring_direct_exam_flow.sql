-- Fix: câu đúng/sai (true_false) luôn được 0 điểm dù trả lời đúng hết.
--
-- Nguyên nhân: score_exam_session() tra điểm TF theo 2 nguồn, theo thứ tự:
--   1) question_tf_score_steps (theo question_id)  — bảng này chưa từng được
--      ghi dữ liệu ở bất kỳ đâu trong hệ thống (chỉ tồn tại trong generated
--      types), luôn rỗng.
--   2) exam_blueprint_section_score_steps (theo blueprint_section_id) — chỉ
--      có dữ liệu cho các blueprint môn học cũ. Từ migration
--      20260926063648_exam_sessions_direct_exam_flow.sql, luồng "làm đề trực
--      tiếp" (ngân hàng đề thi + VIP) tạo exam_session_questions với
--      blueprint_section_id = NULL vì không gắn được vào blueprint nào.
--
-- coalesce(...) của cả 2 nguồn đều NULL -> rơi về mặc định 0, bất kể học
-- sinh trả lời đúng bao nhiêu ý. Vá bằng cách thêm một nhánh fallback thứ 3:
-- công thức điểm bậc thang chuẩn BGD 2025 (0 ý đúng = 0, 1 = 10%, 2 = 25%,
-- 3 = 50%, 4 = 100% số điểm câu) khi câu có đúng 4 ý — áp dụng luôn cho các
-- câu không có blueprint_section_id lẫn các câu có nhưng thiếu bậc thang
-- tùy biến. Câu có số ý khác 4 (hiếm) thì chia đều theo tỉ lệ số ý đúng.
create or replace function public.score_exam_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_student_id uuid;
  v_status text;
  v_score numeric;
  v_caller uuid;
  v_total_score numeric := 0;
  v_rec record;
  v_answer_json jsonb;
  v_selected_option uuid;
  v_is_correct boolean;
  v_earned numeric;
  v_correct_count integer;
  v_tf_total integer;
  v_item_correct boolean;
  v_item_key record;
  v_sa_text text;
  v_sa_key record;
  v_sa_matched boolean;
  v_numeric_val numeric;
begin
  -- Khóa hàng phiên để tuần tự hóa: 2 lời gọi đồng thời (lazy + cron) không chấm
  -- trùng — lời gọi sau thấy score đã có thì thoát sớm.
  select session.student_id, session.status, session.score
    into v_student_id, v_status, v_score
  from public.exam_sessions session
  where session.id = p_session_id
  for update;

  if v_student_id is null then
    raise exception 'Session not found';
  end if;

  -- Quyền: nếu có người gọi (auth.uid() khác null) thì phải là chủ phiên hoặc
  -- staff. Khi chạy nền qua pg_cron, auth.uid() = null → cho phép.
  v_caller := (select auth.uid());
  if v_caller is not null
     and v_caller <> v_student_id
     and not private.is_staff() then
    raise exception 'Permission denied';
  end if;

  -- Idempotent: chỉ chấm phiên ĐÃ nộp và CHƯA có điểm.
  if v_status <> 'submitted' or v_score is not null then
    return;
  end if;

  for v_rec in
    select
      answer.id as answer_id,
      answer.answer_json,
      answer.selected_option_id,
      answer.short_answer_text,
      answer.session_question_id,
      session_question.question_id,
      session_question.blueprint_section_id,
      session_question.max_points,
      question.type as question_type
    from public.session_answers answer
    join public.exam_session_questions session_question
      on session_question.id = answer.session_question_id
    join public.questions question
      on question.id = session_question.question_id
    where session_question.session_id = p_session_id
      and answer.student_id = v_student_id
  loop
    v_answer_json := coalesce(v_rec.answer_json, '{}'::jsonb);
    v_is_correct := false;
    v_earned := 0;

    if v_rec.question_type = 'multiple_choice' then
      v_selected_option := coalesce(
        nullif(v_answer_json ->> 'option_id', '')::uuid,
        v_rec.selected_option_id
      );

      if v_selected_option is not null then
        select exists(
          select 1
          from public.question_correct_options correct_option
          where correct_option.question_id = v_rec.question_id
            and correct_option.option_id = v_selected_option
        ) into v_is_correct;

        if v_is_correct then
          v_earned := v_rec.max_points;
        end if;
      end if;

      update public.session_answers
      set is_correct = v_is_correct,
          earned_points = v_earned,
          grader = '{"type":"auto","method":"mcq_exact"}'::jsonb
      where id = v_rec.answer_id;

    elsif v_rec.question_type = 'true_false' then
      v_correct_count := 0;
      v_tf_total := 0;

      for v_item_key in
        select key.item_id, key.correct_value
        from public.question_true_false_answer_keys key
        where key.question_id = v_rec.question_id
      loop
        v_tf_total := v_tf_total + 1;
        v_item_correct := false;

        if v_answer_json -> 'items' ->> v_item_key.item_id::text is not null then
          if (
            (v_answer_json -> 'items' ->> v_item_key.item_id::text = 'true' and v_item_key.correct_value = true)
            or
            (v_answer_json -> 'items' ->> v_item_key.item_id::text = 'false' and v_item_key.correct_value = false)
          ) then
            v_item_correct := true;
            v_correct_count := v_correct_count + 1;
          end if;
        end if;

        insert into public.session_tf_item_answers (
          session_question_id,
          item_id,
          selected_value,
          is_correct
        )
        values (
          v_rec.session_question_id,
          v_item_key.item_id,
          case
            when v_answer_json -> 'items' ->> v_item_key.item_id::text = 'true' then true
            when v_answer_json -> 'items' ->> v_item_key.item_id::text = 'false' then false
            else null
          end,
          v_item_correct
        )
        on conflict (session_question_id, item_id)
        do update set
          selected_value = excluded.selected_value,
          is_correct = excluded.is_correct,
          updated_at = now();
      end loop;

      select coalesce(
        (
          select step.points
          from public.question_tf_score_steps step
          where step.question_id = v_rec.question_id
            and step.correct_item_count = v_correct_count
        ),
        (
          select step.points
          from public.exam_blueprint_section_score_steps step
          where step.section_id = v_rec.blueprint_section_id
            and step.correct_item_count = v_correct_count
        ),
        -- Fallback: không có bậc thang tùy biến (câu từ ngân hàng đề thi /
        -- làm-đề-trực-tiếp không có blueprint_section_id) -> áp công thức
        -- chuẩn BGD 2025 thay vì mặc định 0.
        case
          when v_tf_total = 4 then
            case v_correct_count
              when 4 then v_rec.max_points
              when 3 then v_rec.max_points * 0.50
              when 2 then v_rec.max_points * 0.25
              when 1 then v_rec.max_points * 0.10
              else 0
            end
          when v_tf_total > 0 then
            round(v_rec.max_points * v_correct_count / v_tf_total, 2)
          else 0
        end
      )
      into v_earned;

      v_is_correct := (v_earned = v_rec.max_points);

      update public.session_answers
      set is_correct = v_is_correct,
          correct_item_count = v_correct_count,
          earned_points = v_earned,
          grader = '{"type":"auto","method":"tf_partial"}'::jsonb
      where id = v_rec.answer_id;

    elsif v_rec.question_type = 'short_answer' then
      v_sa_text := trim(coalesce(v_answer_json ->> 'value', v_rec.short_answer_text));
      v_sa_matched := false;

      if v_sa_text is not null and v_sa_text <> '' then
        for v_sa_key in
          select key.*
          from public.question_short_answer_keys key
          where key.question_id = v_rec.question_id
        loop
          if v_sa_key.answer_type = 'numeric' then
            begin
              v_numeric_val := v_sa_text::numeric;
              if v_sa_key.numeric_value is not null
                and abs(v_numeric_val - v_sa_key.numeric_value) <= coalesce(v_sa_key.tolerance, 0)
              then
                v_sa_matched := true;
              end if;
            exception when others then
              null;
            end;
          elsif v_sa_key.answer_type in ('text', 'expression') then
            if v_sa_key.match_mode = 'exact' then
              if v_sa_key.case_sensitive then
                v_sa_matched := (v_sa_text = v_sa_key.normalized_text);
              else
                v_sa_matched := (lower(v_sa_text) = lower(v_sa_key.normalized_text));
              end if;
            elsif v_sa_key.match_mode = 'contains' then
              if v_sa_key.case_sensitive then
                v_sa_matched := (v_sa_text like '%' || v_sa_key.normalized_text || '%');
              else
                v_sa_matched := (lower(v_sa_text) like '%' || lower(v_sa_key.normalized_text) || '%');
              end if;
            elsif v_sa_key.match_mode = 'starts_with' then
              if v_sa_key.case_sensitive then
                v_sa_matched := (v_sa_text like v_sa_key.normalized_text || '%');
              else
                v_sa_matched := (lower(v_sa_text) like lower(v_sa_key.normalized_text) || '%');
              end if;
            end if;
          elsif v_sa_key.answer_type = 'regex' and v_sa_key.regex_pattern is not null then
            begin
              v_sa_matched := (v_sa_text ~ v_sa_key.regex_pattern);
            exception when others then
              v_sa_matched := false;
            end;
          end if;

          exit when v_sa_matched;
        end loop;
      end if;

      v_is_correct := v_sa_matched;
      if v_sa_matched then
        v_earned := v_rec.max_points;
      end if;

      update public.session_answers
      set is_correct = v_is_correct,
          earned_points = v_earned,
          grader = '{"type":"auto","method":"short_answer"}'::jsonb
      where id = v_rec.answer_id;

    elsif v_rec.question_type = 'essay' then
      update public.session_answers
      set grader = '{"type":"pending","method":"manual"}'::jsonb
      where id = v_rec.answer_id;
    end if;

    v_total_score := v_total_score + v_earned;
  end loop;

  update public.exam_sessions
  set score = v_total_score,
      scored_at = now(),
      updated_at = now()
  where id = p_session_id;
end;
$$;
revoke all on function public.score_exam_session(uuid) from public, anon;
grant execute on function public.score_exam_session(uuid) to authenticated;
comment on function public.score_exam_session(uuid) is
  'Chấm điểm 1 phiên đã nộp (idempotent). Gọi bởi chủ phiên khi xem kết quả, staff, hoặc worker nền. Fallback công thức BGD 2025 cho câu TF thiếu bậc thang tùy biến (vd: đề trực tiếp từ ngân hàng đề thi, không gắn blueprint_section_id).';

-- Chấm lại các phiên true_false đã lỡ bị chấm 0 điểm sai do bug trên (đã nộp,
-- đã có score, nhưng có ít nhất 1 câu TF earned_points=0 mà đáng lẽ đúng >=1
-- ý). Reset score/scored_at về NULL để score_exam_session() chấm lại đúng.
update public.exam_sessions session
set score = null,
    scored_at = null
where session.status = 'submitted'
  and session.score is not null
  and exists (
    select 1
    from public.session_answers answer
    join public.exam_session_questions sq on sq.id = answer.session_question_id
    join public.questions q on q.id = sq.question_id
    where sq.session_id = session.id
      and answer.student_id = session.student_id
      and q.type = 'true_false'
      and coalesce(answer.earned_points, 0) = 0
      and coalesce(answer.correct_item_count, 0) > 0
  );
