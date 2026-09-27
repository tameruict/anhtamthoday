'use client';

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Moon, Sun, Clock, BookOpen, Award, ChevronDown, ChevronUp, Inbox, KeyRound, LogOut } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import {
  clearReferenceCache,
  fetchSessionReview,
  getSupabaseErrorMessage,
  questionTypeLabel,
  type SessionReview,
  type SessionReviewQuestion,
  type SessionReviewAnswer,
  type ExamQuestionType,
} from '@/lib/supabase/exam-data';
import { useExamStore } from '@/store/useExamStore';
import QuestionRenderer, { MathText } from '@/components/question/QuestionRenderer';
import type { RenderableQuestion } from '@/components/question/QuestionRenderer';
import { formatHanoiDateTime } from '@/lib/datetime';
import styles from '@/styles/result.module.css';
import StudentNav from '@/components/ui/StudentNav';

/* ─── Types ──────────────────────────────────────────── */
type ReviewFilter = 'all' | 'correct' | 'wrong' | 'unanswered';

type QuestionReviewItem = {
  question: SessionReviewQuestion;
  answer: SessionReviewAnswer;
  status: 'correct' | 'wrong' | 'unanswered';
  earnedPoints: number;
  maxPoints: number;
};

type TypeBreakdown = {
  type: ExamQuestionType;
  label: string;
  earned: number;
  max: number;
  correct: number;
  wrong: number;
  unanswered: number;
  total: number;
};

/* Nhãn tiếng Việt cho status enum (khi phiên chưa có điểm). */
const STATUS_VN: Record<string, string> = {
  in_progress: 'Đang làm',
  submitted: 'Chờ chấm',
  expired: 'Hết giờ',
  abandoned: 'Đã hủy',
};

/* ─── SVG Donut Chart ────────────────────────────────── */
function ScoreDonut({ percent, score10 }: { percent: number; score10: string }) {
  const r = 72;
  const circumference = 2 * Math.PI * r;
  const [offset, setOffset] = useState(circumference);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setOffset(circumference - (percent / 100) * circumference);
    }, 120);
    return () => clearTimeout(timeout);
  }, [circumference, percent]);

  return (
    <div className={styles.donutWrap} role="img" aria-label={`Điểm ${score10} trên 10`}>
      <svg viewBox="0 0 180 180" aria-hidden="true">
        <defs>
          <linearGradient id="scoreGradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="var(--primary)" />
            <stop offset="100%" stopColor="var(--accent)" />
          </linearGradient>
        </defs>
        <circle className={styles.donutTrack} cx="90" cy="90" r={r} />
        <circle
          className={styles.donutValue}
          cx="90"
          cy="90"
          r={r}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <div className={styles.donutCenter}>
        <span className={styles.donutScore}>{score10}</span>
        <span className={styles.donutLabel}>/ 10 điểm</span>
      </div>
    </div>
  );
}

/* ─── Helpers ────────────────────────────────────────── */
function formatDuration(startedAt: string, submittedAt: string | null): string {
  if (!submittedAt) return 'Chưa nộp bài';
  const startMs = new Date(startedAt).getTime();
  const endMs = new Date(submittedAt).getTime();
  const diffSeconds = Math.max(0, Math.floor((endMs - startMs) / 1000));
  const hours = Math.floor(diffSeconds / 3600);
  const minutes = Math.floor((diffSeconds % 3600) / 60);
  const seconds = diffSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes} phút ${seconds} giây`;
  return `${seconds} giây`;
}

function hasMeaningfulAnswer(answer: SessionReviewAnswer): boolean {
  if (!answer) return false;
  if (answer.selectedOptionId) return true;
  if (answer.shortAnswerText && answer.shortAnswerText.trim()) return true;
  if (
    answer.answerJson &&
    typeof answer.answerJson === 'object' &&
    'items' in answer.answerJson
  ) {
    const items = (answer.answerJson as { items?: Record<string, unknown> }).items;
    return Boolean(items && Object.keys(items).length > 0);
  }
  return false;
}

function buildReviewItems(questions: SessionReviewQuestion[]): QuestionReviewItem[] {
  return questions.map((question) => {
    const answer = question.answer;
    let status: 'correct' | 'wrong' | 'unanswered' = 'unanswered';

    if (hasMeaningfulAnswer(answer)) {
      if (answer?.isCorrect === true) status = 'correct';
      else if (answer?.isCorrect === false) status = 'wrong';
      else status = 'wrong'; // có làm nhưng không đúng / chờ chấm tay
    }

    return {
      question,
      answer,
      status,
      earnedPoints: answer?.earnedPoints ?? 0,
      maxPoints: question.maxPoints,
    };
  });
}

function buildTypeBreakdowns(items: QuestionReviewItem[]): TypeBreakdown[] {
  const map = new Map<ExamQuestionType, TypeBreakdown>();
  for (const item of items) {
    const type = item.question.type;
    if (!map.has(type)) {
      map.set(type, {
        type,
        label: questionTypeLabel(type),
        earned: 0,
        max: 0,
        correct: 0,
        wrong: 0,
        unanswered: 0,
        total: 0,
      });
    }
    const b = map.get(type)!;
    b.earned += item.earnedPoints;
    b.max += item.maxPoints;
    b.total += 1;
    if (item.status === 'correct') b.correct += 1;
    else if (item.status === 'wrong') b.wrong += 1;
    else b.unanswered += 1;
  }
  const order: ExamQuestionType[] = ['multiple_choice', 'true_false', 'short_answer', 'essay'];
  return order.filter((t) => map.has(t)).map((t) => map.get(t)!);
}

function toRenderableQuestion(q: SessionReviewQuestion): RenderableQuestion {
  return {
    id: q.id,
    displayNo: q.displayNo,
    type: q.type,
    content: q.content,
    imageUrl: q.imageUrl,
    imageAltText: q.imageAltText,
    imageWidth: q.imageWidth,
    imageHeight: q.imageHeight,
    options: q.options.map((o) => ({
      id: o.id,
      label: o.label,
      content: o.content,
      imageUrl: o.imageUrl,
      imageAltText: o.imageAltText,
      imageWidth: o.imageWidth,
      imageHeight: o.imageHeight,
      correct: o.correct,
    })),
    trueFalseItems: q.trueFalseItems.map((t) => ({
      id: t.id,
      label: t.label,
      content: t.content,
      correct: t.correctValue ?? undefined,
    })),
    maxPoints: q.maxPoints,
  };
}

function readTfItems(answer: SessionReviewAnswer): Record<string, string> {
  if (
    answer?.answerJson &&
    typeof answer.answerJson === 'object' &&
    'items' in answer.answerJson
  ) {
    return (
      (answer.answerJson as { items?: Record<string, string> }).items ?? {}
    );
  }
  return {};
}

function getStudentAnswerLabel(
  question: SessionReviewQuestion,
  answer: SessionReviewAnswer,
): string {
  if (!hasMeaningfulAnswer(answer)) return 'Không trả lời';

  if (question.type === 'multiple_choice') {
    const option = question.options.find((o) => o.id === answer?.selectedOptionId);
    return option ? `${option.label}. ${option.content}` : 'Không xác định';
  }

  if (question.type === 'true_false') {
    const items = readTfItems(answer);
    const parts = question.trueFalseItems.map((item) => {
      const val = items[item.id];
      const label = item.label ? `${item.label}) ` : '';
      return `${label}${val === 'true' ? 'Đúng' : val === 'false' ? 'Sai' : '—'}`;
    });
    return parts.join('; ');
  }

  if (question.type === 'short_answer' || question.type === 'essay') {
    return answer?.shortAnswerText || 'Không trả lời';
  }

  return 'Không trả lời';
}

function getCorrectAnswerLabel(question: SessionReviewQuestion): string {
  if (question.type === 'multiple_choice') {
    const correct = question.options.filter((o) => o.correct);
    if (correct.length === 0) return '—';
    return correct.map((o) => `${o.label}. ${o.content}`).join('; ');
  }

  if (question.type === 'true_false') {
    return question.trueFalseItems
      .map((item) => {
        const label = item.label ? `${item.label}) ` : '';
        return `${label}${item.correctValue === true ? 'Đúng' : item.correctValue === false ? 'Sai' : '—'}`;
      })
      .join('; ');
  }

  if (question.type === 'short_answer') {
    const keys = question.shortAnswerKeys
      .map((k) => k.display)
      .filter((v): v is string => Boolean(v));
    return keys.length > 0 ? keys.join(' hoặc ') : '—';
  }

  return '—';
}

/* ─── Review item memo ───────────────────────────────────────────
 * toRenderableQuestion tạo object mới mỗi lần gọi → phá memo của
 * QuestionRenderer. Bọc từng dòng review trong memo + useMemo renderable
 * để expand/collapse 1 câu không re-render 39 câu còn lại. */
const ReviewItem = memo(function ReviewItem({
  item,
  expanded,
  onToggle,
}: {
  item: QuestionReviewItem;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const renderable = useMemo(
    () => toRenderableQuestion(item.question),
    [item.question],
  );
  const statusClass =
    item.status === 'correct'
      ? styles.reviewItemCorrect
      : item.status === 'wrong'
        ? styles.reviewItemWrong
        : styles.reviewItemUnanswered;

  return (
    <div className={`${styles.reviewItem} ${statusClass}`}>
      <button
        type="button"
        className={styles.reviewItemHead}
        aria-expanded={expanded}
        aria-controls={`review-body-${item.question.id}`}
        onClick={() => onToggle(item.question.id)}
      >
        <span className={styles.reviewItemNo}>
          Câu {item.question.displayNo} — {questionTypeLabel(item.question.type)}
        </span>
        <div className={styles.reviewItemBadges}>
          <span
            className={`${styles.badge} ${
              item.status === 'correct'
                ? styles.badgeCorrect
                : item.status === 'wrong'
                  ? styles.badgeWrong
                  : styles.badgeUnanswered
            }`}
          >
            {item.status === 'correct'
              ? '✓ Đúng'
              : item.status === 'wrong'
                ? '✗ Sai'
                : '— Chưa trả lời'}
          </span>
          <span className={`${styles.badge} ${styles.badgePoints}`}>
            {item.earnedPoints.toFixed(1)} / {item.maxPoints.toFixed(1)} đ
          </span>
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </div>
      </button>

      {expanded && (
        <div className={styles.reviewItemBody} id={`review-body-${item.question.id}`}>
          <QuestionRenderer
            question={renderable}
            selectedOptionId={item.answer?.selectedOptionId ?? undefined}
            textValue={item.answer?.shortAnswerText ?? ''}
            showSolutions
          />
          <div className={styles.answerCompare}>
            <div className={`${styles.answerRow} ${styles.answerRowStudent}`}>
              <span className={styles.answerLabel}>Bạn chọn:</span>
              <span className={styles.answerValue}>
                {getStudentAnswerLabel(item.question, item.answer)}
              </span>
            </div>
            <div className={`${styles.answerRow} ${styles.answerRowCorrect}`}>
              <span className={styles.answerLabel}>Đáp án:</span>
              <span className={styles.answerValue}>
                {getCorrectAnswerLabel(item.question)}
              </span>
            </div>
          </div>

          {item.question.solution.explanation && (
            <div className={styles.solutionBlock}>
              <span className={styles.solutionTitle}>Hướng dẫn giải</span>
              <div className={styles.solutionContent}>
                <MathText value={item.question.solution.explanation} />
              </div>
            </div>
          )}

          {!item.question.solution.explanation && item.question.solution.locked && (
            <div className={styles.solutionLocked}>
              <span>Câu này có hướng dẫn giải chi tiết — mở khoá bằng gói VIP để xem.</span>
              <Link className="btn outline small" href="/purchase">
                Nâng cấp VIP
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

/* ─── Component ──────────────────────────────────────── */
export default function ResultPageClient({ sessionId }: { sessionId?: string }) {
  const router = useRouter();
  const {
    hasHydrated,
    theme,
    setTheme,
    finishSession,
    clearDraft,
    candidateInfo,
    logout,
  } = useExamStore();
  const [loggingOut, setLoggingOut] = useState(false);
  // The canonical /result route is always the history list. A stored exam
  // session must not silently turn that route into a detail page.
  const currentSessionId = sessionId;
  const supabase = useMemo(() => createClient(), []);
  const [review, setReview] = useState<SessionReview | null>(null);
  const [history, setHistory] = useState<Array<{ id: string; status: string; score: number | null; max_score: number; started_at: string; submitted_at: string | null; exam_rooms?: { name: string; subject_code: string } | { name: string; subject_code: string }[] | null; exams?: { title: string; subject_code: string } | { title: string; subject_code: string }[] | null }>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isScoring, setIsScoring] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('all');
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());

  // Kết thúc: không lưu tiến trình làm bài nữa (xóa bản nháp resume).
  useEffect(() => {
    clearDraft();
  }, [clearDraft]);

  useEffect(() => {
    if (hasHydrated && !candidateInfo && !sessionId) {
      router.push('/');
      return;
    }

  }, [candidateInfo, hasHydrated, router, sessionId]);

  // Canonical /result is a history list; detail remains available at /result/:sessionId.
  useEffect(() => {
    if (!hasHydrated || !candidateInfo || currentSessionId) return;
    let mounted = true;
    supabase.auth.getUser().then(async ({ data: authData, error: authError }) => {
      if (!mounted) return;
      if (authError || !authData.user) {
        setLoadError('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
        setIsLoading(false);
        return;
      }
      const { data, error } = await supabase
        .from('exam_sessions')
        .select('id,status,score,max_score,started_at,submitted_at,exam_rooms(name,subject_code),exams(title,subject_code)')
        .eq('student_id', authData.user.id)
        .order('started_at', { ascending: false })
        .limit(50);
        if (!mounted) return;
        if (error) setLoadError(error.message);
        else {
          setLoadError('');
          setHistory((data ?? []) as typeof history);
        }
        setIsLoading(false);
      });
    return () => { mounted = false; };
  }, [candidateInfo, currentSessionId, hasHydrated, reloadKey, supabase]);

  useEffect(() => {
    if (!hasHydrated || !currentSessionId) return;

    let mounted = true;
    const sessionId = currentSessionId;

    const run = async (attempt: number) => {
      try {
        const data = await fetchSessionReview(supabase, sessionId);
        if (!mounted) return;
        setReview(data);
        setLoadError('');

        // Điểm chưa có (đang chấm) -> thử lại tối đa 3 lần, cách 1.5s.
        if (
          data.session.gradingStatus === 'pending_auto' &&
          data.session.score === null &&
          attempt < 3
        ) {
          setIsScoring(true);
          window.setTimeout(() => {
            if (mounted) void run(attempt + 1);
          }, 1500);
        } else {
          setIsScoring(false);
          setIsLoading(false);
        }
      } catch (error: unknown) {
        if (!mounted) return;
        setLoadError(
          getSupabaseErrorMessage(error, 'Không thể tải kết quả từ Supabase.'),
        );
        setIsScoring(false);
        setIsLoading(false);
      }
    };

    void run(0);

    return () => {
      mounted = false;
    };
  }, [currentSessionId, hasHydrated, reloadKey, supabase]);

  const isPractice = (review?.session.roomCode ?? '')
    .toUpperCase()
    .startsWith('PRACTICE');
  const isArchivedRoom = Boolean(review?.session.roomDeleted);

  /* ─── Derived data ──────────────────────────────────── */
  const reviewItems = useMemo(
    () => (review ? buildReviewItems(review.questions) : []),
    [review],
  );

  const resultStats = useMemo(() => {
    const total = reviewItems.length;
    const correctAnswers = reviewItems.filter((i) => i.status === 'correct').length;
    const wrongAnswers = reviewItems.filter((i) => i.status === 'wrong').length;
    const empty = reviewItems.filter((i) => i.status === 'unanswered').length;
    const answered = total - empty;
    return { total, answered, correctAnswers, wrongAnswers, empty };
  }, [reviewItems]);

  const typeBreakdowns = useMemo(
    () => buildTypeBreakdowns(reviewItems),
    [reviewItems],
  );

  const filteredReviewItems = useMemo(() => {
    if (reviewFilter === 'all') return reviewItems;
    return reviewItems.filter((i) => i.status === reviewFilter);
  }, [reviewItems, reviewFilter]);

  const score = review?.session.score ?? null;
  const maxScore = review?.session.maxScore ?? 10;
  const score10 =
    typeof score === 'number' && maxScore > 0
      ? ((score / maxScore) * 10).toFixed(2)
      : '—';
  const progressPercent =
    typeof score === 'number' && maxScore > 0 ? (score / maxScore) * 100 : 0;
  const subjectName = review?.session.subjectName ?? 'Môn thi';
  const examRoomName = review?.session.roomName ?? 'Phòng thi';
  const timeTaken = review
    ? formatDuration(review.session.startedAt, review.session.submittedAt)
    : '';

  // useCallback để giữ tham chiếu ổn định → memo(ReviewItem) mới phát huy tác dụng.
  const toggleExpand = useCallback((id: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleFinish = () => {
    finishSession();
    router.push('/de-thi');
  };

  const handleRetry = () => {
    setLoadError('');
    setIsLoading(true);
    setReloadKey((value) => value + 1);
  };

  const handleLogout = useCallback(async () => {
    setLoggingOut(true);
    try {
      await supabase.auth.signOut();
      clearReferenceCache();
      logout();
      router.push('/', { transitionTypes: ['nav-back'] });
    } catch {
      setLoggingOut(false);
    }
  }, [logout, router, supabase]);

  const accountTools = (
    <div className={styles.pageTools}>
      <button
        className="btn outline small"
        type="button"
        onClick={() => router.push('/purchase', { transitionTypes: ['nav-forward'] })}
      >
        <KeyRound size={15} />
        <span>Mua thêm lượt</span>
      </button>
      <button
        className="theme-toggle"
        type="button"
        aria-label={theme === 'dark' ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'}
        aria-pressed={theme === 'dark'}
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      >
        <span className="icon">
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </span>
        <span>{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>
      </button>
      <button
        className="btn outline small"
        type="button"
        onClick={handleLogout}
        disabled={loggingOut}
      >
        <LogOut size={15} />
        <span>{loggingOut ? 'Đang đăng xuất...' : 'Đăng xuất'}</span>
      </button>
    </div>
  );

  if (!hasHydrated || (!candidateInfo && !sessionId)) return null;

  if (!currentSessionId) {
    return (
      <div className={styles.screen}>
        <StudentNav />
        {accountTools}
        <h1 className={styles.title} id="result-title">Lịch sử kết quả</h1>
        <main id="main" tabIndex={-1} className={styles.center} aria-labelledby="result-title">
          <section className={styles.card} aria-label="Danh sách phiên thi">
            <h2>Các bài đã hoàn thành</h2>
            <div className={styles.body}>
              {isLoading && <p className={styles.successMessage} role="status">Đang tải lịch sử bài thi...</p>}
              {!isLoading && loadError && (
                <div className={styles.feedbackState} role="alert">
                  <p className={styles.errorText}>{loadError}</p>
                  <button className="btn outline small" type="button" onClick={handleRetry}>
                    Thử tải lại
                  </button>
                </div>
              )}
              {!isLoading && !loadError && history.length === 0 && (
                <div className={styles.feedbackState}>
                  <Inbox className={styles.emptyIcon} size={32} aria-hidden="true" />
                  <p className={styles.emptyReviewNotice}>Chưa có bài thi nào. Hãy bắt đầu một phòng thi để xem kết quả tại đây.</p>
                  <Link className="btn" href="/de-thi">Bắt đầu thi thử</Link>
                </div>
              )}
              {!isLoading && !loadError && history.length > 0 && (
                <ul className={styles.historyList}>
                  {history.map((item) => {
                    const room = Array.isArray(item.exam_rooms) ? item.exam_rooms[0] : item.exam_rooms;
                    const exam = Array.isArray(item.exams) ? item.exams[0] : item.exams;
                    return (
                      <li key={item.id} className={styles.historyItem}>
                        <div><strong>{room?.subject_code ?? exam?.subject_code ?? 'Môn thi'}</strong><span>{room?.name ?? exam?.title ?? 'Phiên thi'} · {formatHanoiDateTime(item.submitted_at ?? item.started_at)}</span></div>
                        {typeof item.score === 'number' ? (
                          <b>{item.score.toFixed(2)} / {item.max_score}</b>
                        ) : (
                          <span
                            className={`badge ${item.status === 'submitted' ? 'badge-warning' : 'badge-info'}`}
                          >
                            {STATUS_VN[item.status] ?? item.status}
                          </span>
                        )}
                        <Link className="btn outline small" href={`/result/${item.id}`}>Xem chi tiết</Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className={styles.screen}>
      <StudentNav />
      {accountTools}
      <h1 className={styles.title} id="result-title">Kết quả phiên thi</h1>
      <main id="main" tabIndex={-1} className={styles.center} aria-labelledby="result-title">
        <div className={styles.mainLayout}>
          {/* ─── Loading / Error card ─── */}
          {(isLoading || loadError) && (
            <section className={styles.card}>
              <h2>Kết quả từ cơ sở dữ liệu</h2>
              <div className={styles.body}>
                {isLoading && (
                  <p className={styles.successMessage}>
                    {isScoring
                      ? 'Đang chấm điểm…'
                      : 'Đang tải kết quả từ Supabase...'}
                  </p>
                )}
                {loadError && (
                  <div className={styles.feedbackState} role="alert">
                    <p className={styles.errorText}>{loadError}</p>
                    <button className="btn outline small" type="button" onClick={handleRetry}>
                      Thử tải lại
                    </button>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* ─── Main result display ─── */}
          {!isLoading && !loadError && review && (
            <>
              {/* Score Hero Card */}
              <section className={styles.card} aria-labelledby="result-score-heading">
                <h2 id="result-score-heading">
                  {subjectName} — {examRoomName}
                </h2>
                {review.session.gradingStatus === 'pending_manual' && (
                  <p className={styles.pendingNotice} role="status" aria-live="polite">
                    Điểm hiện tại là điểm tự động tạm tính. Bài còn chờ admin chấm
                    phần tự luận.
                  </p>
                )}
                {review.session.gradingStatus === 'failed' && (
                  <p className={styles.gradingError} role="alert">
                    Hệ thống chưa hoàn tất chấm tự động. Phiên đã được đưa vào hàng
                    đợi phục hồi.
                  </p>
                )}
                <div className={styles.scoreHero}>
                  <ScoreDonut percent={progressPercent} score10={score10} />
                  <div className={styles.heroDetails}>
                    <div className={styles.heroRow}>
                      <span className={`${styles.heroDot} ${styles.heroDotCorrect}`} />
                      <span>
                        Đúng: <strong>{resultStats.correctAnswers}</strong>
                      </span>
                    </div>
                    <div className={styles.heroRow}>
                      <span className={`${styles.heroDot} ${styles.heroDotWrong}`} />
                      <span>
                        Sai: <strong>{resultStats.wrongAnswers}</strong>
                      </span>
                    </div>
                    <div className={styles.heroRow}>
                      <span className={`${styles.heroDot} ${styles.heroDotEmpty}`} />
                      <span>
                        Bỏ trống: <strong>{resultStats.empty}</strong>
                      </span>
                    </div>
                    <div className={styles.heroRow}>
                      <span>
                        Điểm thô:{' '}
                        <strong>
                          {typeof score === 'number'
                            ? `${score.toFixed(2)} / ${maxScore}`
                            : 'Đang chấm…'}
                        </strong>
                        {typeof score === 'number' ? (
                          <span className={styles.heroScaleNote}> — vòng tròn ở trên là điểm quy về thang 10</span>
                        ) : null}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Meta tags */}
                <ul className={styles.metaBar} aria-label="Thông tin phiên thi">
                  <li className={styles.metaTag}>
                    <Clock size={14} aria-hidden="true" />
                    Thời gian: {timeTaken}
                  </li>
                  <li className={styles.metaTag}>
                    <BookOpen size={14} aria-hidden="true" />
                    {resultStats.answered} / {resultStats.total} câu đã trả lời
                  </li>
                  <li className={styles.metaTag}>
                    <Award size={14} aria-hidden="true" />
                    Lần thi thứ {review.session.attemptNumber}
                  </li>
                  {review.session.submittedAt ? (
                    <li className={styles.metaTag}>
                      <Clock size={14} aria-hidden="true" />
                      Nộp lúc: {formatHanoiDateTime(review.session.submittedAt)}
                    </li>
                  ) : null}
                </ul>
              </section>

              {/* Score Breakdown by Type */}
              {typeBreakdowns.length > 0 && (
                <section className={styles.card} aria-labelledby="result-breakdown-heading">
                  <h2 id="result-breakdown-heading">Phân tích điểm theo dạng câu hỏi</h2>
                  <ul className={styles.breakdownGrid} aria-label="Điểm theo dạng câu hỏi">
                    {typeBreakdowns.map((b) => {
                      const pct = b.max > 0 ? (b.earned / b.max) * 100 : 0;
                      return (
                        <li key={b.type} className={styles.breakdownItem}>
                          <div className={styles.breakdownType}>{b.label}</div>
                          <div className={styles.breakdownScore}>
                            {b.earned.toFixed(1)} <span>/ {b.max.toFixed(1)} điểm</span>
                          </div>
                          <div
                            className={styles.breakdownBar}
                            role="progressbar"
                            aria-valuenow={Math.round(pct)}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-label={`${b.label}: ${b.earned.toFixed(1)} trên ${b.max.toFixed(1)} điểm`}
                          >
                            <div
                              className={styles.breakdownBarFill}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <div className={styles.breakdownCount}>
                            {b.correct} đúng · {b.wrong} sai · {b.unanswered} bỏ trống — {b.total} câu
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              {/* Detailed Answer Review — ẩn với phòng luyện tập (PRACTICE) */}
              {isArchivedRoom ? (
                <section className={styles.card}>
                  <h3 className={styles.reviewTitle}>Phòng thi đã được gỡ</h3>
                  <p className={styles.restrictedReviewNotice}>
                    Phòng thi đã bị gỡ — chỉ hiển thị điểm. Đề thi, bài làm và đáp án không còn được hiển thị.
                  </p>
                </section>
              ) : isPractice ? (
                <section className={styles.card}>
                  <h3 className={styles.reviewTitle}>Xem lại bài làm</h3>
                  <p className={styles.restrictedReviewNotice}>
                    Phòng luyện tập không hiển thị đáp án chi tiết để bạn tự ôn lại.
                  </p>
                </section>
              ) : (
                <section className={styles.card} aria-labelledby="result-review-heading">
                  <div className={styles.reviewHeader}>
                    <h3 className={styles.reviewTitle} id="result-review-heading">Xem lại bài làm &amp; đáp án</h3>
                    <div className={styles.reviewFilter} role="tablist" aria-label="Lọc câu hỏi theo kết quả">
                      {(
                        [
                          ['all', 'Tất cả'],
                          ['correct', 'Đúng'],
                          ['wrong', 'Sai'],
                          ['unanswered', 'Bỏ trống'],
                        ] as [ReviewFilter, string][]
                      ).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          role="tab"
                          aria-selected={reviewFilter === value}
                          className={`${styles.filterBtn} ${
                            reviewFilter === value ? styles.filterBtnActive : ''
                          }`}
                          onClick={() => setReviewFilter(value)}
                        >
                          {label}
                          {value !== 'all' && (
                            <>
                              {' '}
                              (
                              {value === 'correct'
                                ? resultStats.correctAnswers
                                : value === 'wrong'
                                  ? resultStats.wrongAnswers
                                  : resultStats.empty}
                              )
                            </>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className={styles.reviewList}>
                    {filteredReviewItems.length === 0 && (
                      <p className={styles.emptyReviewNotice}>
                        Không có câu hỏi nào ở bộ lọc này.
                      </p>
                    )}
                    {filteredReviewItems.map((item) => (
                      <ReviewItem
                        key={item.question.id}
                        item={item}
                        expanded={expandedItems.has(item.question.id)}
                        onToggle={toggleExpand}
                      />
                    ))}
                  </div>
                </section>
              )}

              {/* Finish button */}
              <div className={styles.actions}>
                <button className="btn" type="button" onClick={handleFinish}>
                  Về trang chọn môn
                </button>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
