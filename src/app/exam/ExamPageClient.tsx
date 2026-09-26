'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle, Flag, Maximize, Moon, Sun, AlertTriangle, X, Eye, Timer } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import {
  fetchExamSessionData,
  getSupabaseErrorMessage,
  saveSessionAnswers,
  type ExamSessionData,
  type ExamSessionQuestion,
  type SessionAnswerInput,
} from '@/lib/supabase/exam-data';
import QuestionRenderer, {
  serializeShortAnswerForScoring,
  type RenderableQuestion,
} from '@/components/question/QuestionRenderer';
import { useExamStore, type CandidateInfo } from '@/store/useExamStore';
import styles from '@/styles/exam.module.css';

type TrueFalseDraft = Record<string, 'true' | 'false'>;

function readTrueFalseAnswer(value: unknown): TrueFalseDraft {
  if (!value || typeof value !== 'object' || !('items' in value)) {
    return {};
  }

  const items = (value as { items?: unknown }).items;
  if (!items || typeof items !== 'object') {
    return {};
  }

  return Object.entries(items as Record<string, unknown>).reduce<TrueFalseDraft>(
    (draft, [itemId, itemValue]) => {
      if (itemValue === 'true' || itemValue === true) {
        draft[itemId] = 'true';
      }
      if (itemValue === 'false' || itemValue === false) {
        draft[itemId] = 'false';
      }
      return draft;
    },
    {},
  );
}

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
  const remainingSeconds = (seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainingSeconds}`;
}

/* ─── Đồng hồ đếm ngược tự tick ──────────────────────────────────────────
 * Trước đây `nowMs` nằm ở ExamPage nên TOÀN BỘ trang (40 nút nav + 2
 * QuestionRenderer parse Markdown/KaTeX) re-render mỗi giây → lag thấy rõ
 * trên máy yếu. Tách đồng hồ ra component riêng: chỉ badge đồng hồ tự
 * render lại mỗi giây, parent đứng yên. Hết giờ → gọi onExpire 1 lần để
 * parent tự nộp bài. */
function useCountdown(deadlineMs: number | null, durationSeconds: number) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    // Gần hết giờ mới cần nhịp giây; còn nhiều giờ thì tick thưa cho nhẹ.
    const msToDeadline = deadlineMs !== null ? deadlineMs - Date.now() : durationSeconds * 1000;
    const intervalMs = msToDeadline > 600_000 ? 5000 : 1000;
    const timer = setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [deadlineMs, durationSeconds]);

  return deadlineMs !== null
    ? Math.max(Math.floor((deadlineMs - nowMs) / 1000), 0)
    : durationSeconds;
}

function ExamTimerBadge({
  deadlineMs,
  durationSeconds,
  onExpire,
}: {
  deadlineMs: number | null;
  durationSeconds: number;
  onExpire: () => void;
}) {
  const timeLeft = useCountdown(deadlineMs, durationSeconds);
  const expiredRef = useRef(false);
  const timerWarning = timeLeft <= 60 ? 'critical' : timeLeft <= 300 ? 'warning' : 'normal';
  const isUrgent = timerWarning !== 'normal';

  useEffect(() => {
    if (timeLeft === 0 && !expiredRef.current) {
      expiredRef.current = true;
      onExpire();
    }
  }, [timeLeft, onExpire]);

  return (
    <div
      className={`${styles.timer} ${timerWarning === 'critical' ? styles.timerCritical : timerWarning === 'warning' ? styles.timerWarning : ''}`}
      role="timer"
      aria-live={timerWarning === 'normal' ? 'off' : 'assertive'}
      aria-atomic="true"
      aria-label={`Thời gian còn lại ${formatTime(timeLeft)}${isUrgent ? ', sắp hết giờ' : ''}`}
    >
      {/* Tín hiệu phi-màu: icon đổi Timer → AlertTriangle + nhãn text khi sắp hết giờ. */}
      {isUrgent ? (
        <AlertTriangle size={18} aria-hidden="true" />
      ) : (
        <Timer size={18} aria-hidden="true" />
      )}{' '}
      <span aria-hidden="true">{formatTime(timeLeft)}</span>
      {isUrgent ? (
        <span className={styles.timerLabel} aria-hidden="true">Sắp hết giờ</span>
      ) : null}
    </div>
  );
}

function ExamTimeText({
  deadlineMs,
  durationSeconds,
}: {
  deadlineMs: number | null;
  durationSeconds: number;
}) {
  const timeLeft = useCountdown(deadlineMs, durationSeconds);
  return <strong>{formatTime(timeLeft)}</strong>;
}

function toRenderableQuestion(question: ExamSessionQuestion): RenderableQuestion {
  return {
    id: question.id,
    displayNo: question.displayNo,
    type: question.type,
    content: question.content,
    imageUrl: question.imageUrl,
    imageAltText: question.imageAltText,
    imageWidth: question.imageWidth,
    imageHeight: question.imageHeight,
    maxPoints: question.maxPoints,
    options: question.options.map((option) => ({
      id: option.id,
      label: option.label,
      content: option.content,
      imageUrl: option.imageUrl,
      imageAltText: option.imageAltText,
      imageWidth: option.imageWidth,
      imageHeight: option.imageHeight,
    })),
    trueFalseItems: question.trueFalseItems.map((item) => ({
      id: item.id,
      label: item.label,
      content: item.content,
    })),
  };
}

export default function ExamPageClient({
  sessionId,
  candidate,
}: {
  sessionId?: string;
  candidate?: CandidateInfo;
}) {
  const router = useRouter();
  const {
    hasHydrated,
    theme,
    setTheme,
    zoom,
    setZoom,
    currentQuestion,
    setCurrentQuestion,
    marked,
    toggleMark,
    candidateInfo: storedCandidateInfo,
    currentSessionId: storedSessionId,
    examDraft,
    setDraft,
    clearDraft,
  } = useExamStore();
  const currentSessionId = sessionId ?? storedSessionId;
  const candidateInfo = candidate ?? storedCandidateInfo;

  // Tạo client 1 lần và tái sử dụng trong mọi handlers
  const supabase = useMemo(() => createClient(), []);

  const [examData, setExamData] = useState<ExamSessionData | null>(null);
  const [choiceAnswers, setChoiceAnswers] = useState<Record<string, string>>({});
  const [textAnswers, setTextAnswers] = useState<Record<string, string>>({});
  const [trueFalseAnswers, setTrueFalseAnswers] = useState<
    Record<string, TrueFalseDraft>
  >({});
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saveError, setSaveError] = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [showReviewPanel, setShowReviewPanel] = useState(false);
  const [tabSwitchCount, setTabSwitchCount] = useState(0);
  const [showTabWarning, setShowTabWarning] = useState(false);
  const [tabLockState, setTabLockState] = useState<'checking' | 'primary' | 'blocked'>(
    'checking',
  );
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSubmittedRef = useRef(false);

  // Buffer ghi đáp án: gom và khử trùng theo câu hỏi trước khi flush.
  const dirtyRef = useRef<Map<string, SessionAnswerInput>>(new Map());
  const flushPromiseRef = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    if (!currentSessionId) return;

    const lockKey = `exam-session-lock:${currentSessionId}`;
    const tabId = crypto.randomUUID();
    const leaseMs = 15_000;

    const readLock = () => {
      try {
        return JSON.parse(localStorage.getItem(lockKey) ?? 'null') as {
          tabId?: string;
          expiresAt?: number;
        } | null;
      } catch {
        return null;
      }
    };

    const acquireOrRefresh = () => {
      const now = Date.now();
      const current = readLock();
      if (
        !current?.tabId ||
        current.tabId === tabId ||
        Number(current.expiresAt ?? 0) <= now
      ) {
        localStorage.setItem(
          lockKey,
          JSON.stringify({ tabId, expiresAt: now + leaseMs }),
        );
        setTabLockState(readLock()?.tabId === tabId ? 'primary' : 'blocked');
      } else {
        setTabLockState('blocked');
      }
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key === lockKey) acquireOrRefresh();
    };
    const release = () => {
      if (readLock()?.tabId === tabId) localStorage.removeItem(lockKey);
    };

    acquireOrRefresh();
    const interval = window.setInterval(acquireOrRefresh, 5_000);
    window.addEventListener('storage', handleStorage);
    window.addEventListener('pagehide', release);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('pagehide', release);
      release();
    };
  }, [currentSessionId]);

  useEffect(() => {
    if (!hasHydrated) return;

    if (!candidateInfo) {
      router.push('/');
      return;
    }

    if (!currentSessionId) {
      router.push('/de-thi');
    }
  }, [candidateInfo, currentSessionId, hasHydrated, router]);

  useEffect(() => {
    if (!hasHydrated || !currentSessionId) return;

    let isMounted = true;

    fetchExamSessionData(supabase, currentSessionId)
      .then((data) => {
        if (!isMounted) return;

        const durationSec = (data.room?.durationMinutes ?? 50) * 60;
        const deadlineMs = data.session.dueAt
          ? new Date(data.session.dueAt).getTime()
          : new Date(data.session.startedAt).getTime() + durationSec * 1000;

        // Phiên đã kết thúc hoặc đã hết giờ -> không cho làm bài, sang trang kết quả.
        if (data.session.status !== 'in_progress' || Date.now() >= deadlineMs) {
          router.replace(`/result/${currentSessionId}`);
          return;
        }

        const nextChoices: Record<string, string> = {};
        const nextTexts: Record<string, string> = {};
        const nextTrueFalse: Record<string, TrueFalseDraft> = {};

        data.answers.forEach((answer) => {
          const question = data.questions.find(
            (item) => item.id === answer.sessionQuestionId,
          );
          if (!question) return;

          if (question.type === 'multiple_choice' && answer.selectedOptionId) {
            nextChoices[question.id] = answer.selectedOptionId;
          }

          if (
            question.type === 'short_answer' ||
            question.type === 'essay'
          ) {
            nextTexts[question.id] = answer.shortAnswerText ?? '';
          }

          if (question.type === 'true_false') {
            nextTrueFalse[question.id] = readTrueFalseAnswer(answer.answerJson);
          }
        });

        // Resume: phủ bản nháp cục bộ (các sửa đổi gần nhất chưa kịp flush) lên trên DB.
        if (examDraft && examDraft.sessionId === currentSessionId) {
          Object.assign(nextChoices, examDraft.choiceAnswers);
          Object.assign(nextTexts, examDraft.textAnswers);
          Object.assign(nextTrueFalse, examDraft.trueFalseAnswers);
        }

        setExamData(data);
        setChoiceAnswers(nextChoices);
        setTextAnswers(nextTexts);
        setTrueFalseAnswers(nextTrueFalse);
        setLoadError('');
      })
      .catch((error: unknown) => {
        if (!isMounted) return;
        console.error('[exam] fetchExamSessionData failed', error);
        setLoadError(
          getSupabaseErrorMessage(error, 'Không thể tải phiên thi từ Supabase.'),
        );
      })
      .finally(() => {
        if (isMounted) setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
    // examDraft cố tình không nằm trong deps: chỉ overlay 1 lần lúc load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId, hasHydrated, loadAttempt, supabase, router]);

  const questions = useMemo(() => examData?.questions ?? [], [examData]);
  const totalQuestions = questions.length;
  const activeQuestion = useMemo(
    () =>
      questions.find((question) => question.number === currentQuestion) ??
      questions[0],
    [currentQuestion, questions],
  );
  const renderableQuestion = useMemo(
    () => (activeQuestion ? toRenderableQuestion(activeQuestion) : null),
    [activeQuestion],
  );
  const durationSeconds = (examData?.room?.durationMinutes ?? 50) * 60;

  const deadlineMs = useMemo(() => {
    if (!examData) return null;
    if (examData.session.dueAt) {
      return new Date(examData.session.dueAt).getTime();
    }
    return (
      new Date(examData.session.startedAt).getTime() + durationSeconds * 1000
    );
  }, [examData, durationSeconds]);

  useEffect(() => {
    if (currentQuestion > Math.max(totalQuestions, 1)) {
      setCurrentQuestion(1);
    }
  }, [currentQuestion, setCurrentQuestion, totalQuestions]);

  // Đồng hồ tick nằm trong ExamTimerBadge/ExamTimeText (component riêng tự
  // render lại mỗi giây). Parent không giữ nowMs nên không re-render cả trang.

  const answeredCount = useMemo(
    () =>
      questions.filter((question) => {
        if (question.type === 'multiple_choice') {
          return Boolean(choiceAnswers[question.id]);
        }
        if (question.type === 'true_false') {
          return Object.keys(trueFalseAnswers[question.id] ?? {}).length > 0;
        }
        return Boolean(textAnswers[question.id]?.trim());
      }).length,
    [choiceAnswers, questions, textAnswers, trueFalseAnswers],
  );

  const room = examData?.room;

  const unansweredQuestions = useMemo(
    () =>
      questions.filter((question) => {
        if (question.type === 'multiple_choice') return !choiceAnswers[question.id];
        if (question.type === 'true_false')
          return Object.keys(trueFalseAnswers[question.id] ?? {}).length === 0;
        return !textAnswers[question.id]?.trim();
      }),
    [choiceAnswers, questions, textAnswers, trueFalseAnswers],
  );

  const markedQuestions = useMemo(
    () => questions.filter((q) => marked.includes(q.number)),
    [questions, marked],
  );

  const resetPanelScroll = useCallback(() => {
    document.getElementById('exam-question-prompt')?.scrollTo({ top: 0, behavior: 'smooth' });
    document.getElementById('exam-answer-panel')?.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const showSaveIndicator = useCallback((status: 'saving' | 'saved' | 'error') => {
    setSaveStatus(status);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (status === 'saved') {
      saveTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
    }
  }, []);

  // Flush buffer đáp án lên DB theo lô (gom + dedup theo câu hỏi).
  const flush = useCallback(async (): Promise<boolean> => {
    if (flushPromiseRef.current) return flushPromiseRef.current;
    if (dirtyRef.current.size === 0) return true;
    if (!currentSessionId) return false;

    const run = (async () => {
      while (dirtyRef.current.size > 0) {
        const pending = dirtyRef.current;
        dirtyRef.current = new Map();
        showSaveIndicator('saving');

        try {
          await saveSessionAnswers(
            supabase,
            currentSessionId,
            Array.from(pending.values()),
          );
          setSaveError('');
          showSaveIndicator('saved');
        } catch (error) {
          // Trả mục lỗi vào buffer nhưng không đè thay đổi mới hơn của cùng câu.
          pending.forEach((value, key) => {
            if (!dirtyRef.current.has(key)) dirtyRef.current.set(key, value);
          });
          setSaveError(getSupabaseErrorMessage(error, 'Không thể lưu đáp án.'));
          showSaveIndicator('error');
          return false;
        }
      }

      return true;
    })();

    flushPromiseRef.current = run;
    try {
      return await run;
    } finally {
      if (flushPromiseRef.current === run) flushPromiseRef.current = null;
    }
  }, [currentSessionId, supabase, showSaveIndicator]);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(() => {
      void flush();
    }, 1500);
  }, [flush]);

  const queueAnswer = useCallback(
    (input: SessionAnswerInput) => {
      dirtyRef.current.set(input.sessionQuestionId, input);
      scheduleFlush();
    },
    [scheduleFlush],
  );

  // Flush định kỳ 10s (an toàn) khi đang làm bài.
  useEffect(() => {
    if (isLoading || !examData) return;
    const interval = setInterval(() => {
      void flush();
    }, 10000);
    return () => clearInterval(interval);
  }, [flush, isLoading, examData]);

  // Flush khi rời tab / đóng trang để không mất đáp án.
  useEffect(() => {
    const handleHide = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    document.addEventListener('visibilitychange', handleHide);
    window.addEventListener('pagehide', handleHide);
    return () => {
      document.removeEventListener('visibilitychange', handleHide);
      window.removeEventListener('pagehide', handleHide);
    };
  }, [flush]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current.size === 0) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // Lưu bản nháp cục bộ (debounce) để resume nhanh khi reload.
  useEffect(() => {
    if (isLoading || !examData || !currentSessionId) return;
    const timeout = setTimeout(() => {
      setDraft({
        sessionId: currentSessionId,
        choiceAnswers,
        textAnswers,
        trueFalseAnswers,
        marked,
        currentQuestion,
        updatedAt: Date.now(),
      });
    }, 800);
    return () => clearTimeout(timeout);
  }, [
    choiceAnswers,
    textAnswers,
    trueFalseAnswers,
    marked,
    currentQuestion,
    currentSessionId,
    examData,
    isLoading,
    setDraft,
  ]);

  const persistChoice = useCallback(
    (question: ExamSessionQuestion, optionId: string, label: string) => {
      setChoiceAnswers((current) => ({ ...current, [question.id]: optionId }));
      setCurrentQuestion(question.number);
      queueAnswer({
        sessionQuestionId: question.id,
        selectedOptionId: optionId,
        answerJson: {
          type: 'multiple_choice',
          option_id: optionId,
          label,
        },
      });
    },
    [queueAnswer, setCurrentQuestion],
  );

  const handleSubmit = useCallback(async (force = false) => {
    if (!force) {
      setShowReviewPanel(true);
      return;
    }

    // Đẩy nốt đáp án trong buffer trước khi nộp.
    const answersSaved = await flush();
    if (!answersSaved) {
      setShowReviewPanel(true);
      return;
    }

    if (currentSessionId) {
      const { error } = await supabase.rpc('submit_exam_session', {
        p_session_id: currentSessionId,
      });
      if (error) {
        setSaveError(getSupabaseErrorMessage(error, 'Không thể nộp bài.'));
        showSaveIndicator('error');
        setShowReviewPanel(true);
        return;
      }
    }

    // Không lưu tiến trình sau khi kết thúc: xóa bản nháp; GIỮ currentSessionId
    // để trang /result tải được kết quả + đáp án.
    clearDraft();
    router.push(`/result/${currentSessionId}`);
  }, [clearDraft, currentSessionId, flush, router, showSaveIndicator, supabase]);

  const handleConfirmSubmit = useCallback(async () => {
    setShowReviewPanel(false);
    await handleSubmit(true);
  }, [handleSubmit]);

  // Tự nộp khi hết giờ: ExamTimerBadge gọi onExpire đúng 1 lần (guard bên trong).
  const handleExpire = useCallback(() => {
    if (isLoading || !examData || autoSubmittedRef.current) return;
    autoSubmittedRef.current = true;
    void handleSubmit(true);
  }, [examData, handleSubmit, isLoading]);

  const recordViolation = useCallback(
    (type: string) => {
      setTabSwitchCount((count) => count + 1);
      setShowTabWarning(true);
      window.setTimeout(() => setShowTabWarning(false), 4000);
      if (currentSessionId) {
        // Ghi log phía server (chỉ tính khi phiên đang thi); bỏ qua lỗi mạng.
        void supabase.rpc('record_session_event', {
          p_session_id: currentSessionId,
          p_type: type,
        });
      }
    },
    [currentSessionId, supabase],
  );

  // Chống gian lận: ghi log khi rời tab (không cưỡng chế).
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden && examData && !isLoading) {
        recordViolation('tab_switch');
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [examData, isLoading, recordViolation]);

  // Chống gian lận: ghi log khi thoát toàn màn hình giữa giờ (không cưỡng chế
  // bật lại — nhiều thiết bị di động không hỗ trợ Fullscreen API).
  useEffect(() => {
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement && examData && !isLoading) {
        recordViolation('fullscreen_exit');
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, [examData, isLoading, recordViolation]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (showReviewPanel) return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;

      const q = questions[currentQuestion - 1];
      switch (e.key.toLowerCase()) {
        case 'n':
        case 'arrowright':
          e.preventDefault();
          if (currentQuestion < totalQuestions) {
            setCurrentQuestion(currentQuestion + 1);
            resetPanelScroll();
          }
          break;
        case 'p':
        case 'arrowleft':
          e.preventDefault();
          if (currentQuestion > 1) {
            setCurrentQuestion(currentQuestion - 1);
            resetPanelScroll();
          }
          break;
        case 'm':
          e.preventDefault();
          toggleMark(currentQuestion);
          break;
        case '1': case '2': case '3': case '4':
          if (q?.type === 'multiple_choice') {
            const optIndex = parseInt(e.key) - 1;
            const opt = q.options[optIndex];
            if (opt) {
              e.preventDefault();
              persistChoice(q, opt.id, opt.label);
            }
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    currentQuestion,
    persistChoice,
    questions,
    resetPanelScroll,
    setCurrentQuestion,
    showReviewPanel,
    toggleMark,
    totalQuestions,
  ]);

  const handleNext = () => {
    if (currentQuestion < totalQuestions) {
      setCurrentQuestion(currentQuestion + 1);
      resetPanelScroll();
    }
  };

  const handlePrev = () => {
    if (currentQuestion > 1) {
      setCurrentQuestion(currentQuestion - 1);
      resetPanelScroll();
    }
  };

  const persistTrueFalse = (
    question: ExamSessionQuestion,
    itemId: string,
    value: 'true' | 'false',
  ) => {
    const nextDraft = {
      ...(trueFalseAnswers[question.id] ?? {}),
      [itemId]: value,
    };

    setTrueFalseAnswers((current) => ({
      ...current,
      [question.id]: nextDraft,
    }));
    setCurrentQuestion(question.number);
    queueAnswer({
      sessionQuestionId: question.id,
      answerJson: {
        type: 'true_false',
        items: nextDraft,
      },
    });
  };

  const persistTextAnswer = (question: ExamSessionQuestion, value: string) => {
    setTextAnswers((current) => ({ ...current, [question.id]: value }));
    const trimmedValue = value.trim();
    queueAnswer({
      sessionQuestionId: question.id,
      shortAnswerText: trimmedValue || null,
      answerJson: {
        type: question.type,
        value:
          question.type === 'short_answer'
            ? serializeShortAnswerForScoring(trimmedValue)
            : trimmedValue,
      },
    });
  };



  if (
    !hasHydrated ||
    !candidateInfo ||
    !currentSessionId ||
    tabLockState === 'checking'
  ) {
    return null;
  }

  if (tabLockState === 'blocked') {
    return (
      <div className={styles.screen}>
        <div className={styles.fullscreenPrompt} role="alert">
          <p>Phiên thi đang mở ở một tab khác. Hãy đóng tab kia rồi tải lại trang này.</p>
          <button type="button" onClick={() => window.location.reload()}>
            Thử lại
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={styles.screen}
      onCopy={(event) => event.preventDefault()}
      onCut={(event) => event.preventDefault()}
      onPaste={(event) => event.preventDefault()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <header className={styles.header} aria-label="Thông tin phiên thi">
        <div>
          <div className={styles.candidateLine}>{candidateInfo.name}</div>
          <div className={styles.candidateSub}>
            SBD: {candidateInfo.code} &nbsp;&nbsp; Môn thi:{' '}
            {(room?.subjectName ?? 'Đang tải').toLocaleUpperCase('vi-VN')}
            &nbsp;&nbsp; {room?.name ?? 'Phiên thi'} &nbsp;&nbsp; Ca thi:{' '}
            {candidateInfo.session}
          </div>
        </div>
        <div className={styles.headerRight}>
          <ExamTimerBadge
            deadlineMs={deadlineMs}
            durationSeconds={durationSeconds}
            onExpire={handleExpire}
          />
          <div className={styles.connection} role="status" aria-live="polite">
            <span className={`${styles.connectionDot} ${saveStatus === 'error' ? styles.connectionError : ''}`} aria-hidden="true"></span>
            <span>{
              saveStatus === 'saving' ? 'Đang lưu...' :
              saveStatus === 'saved' ? '✓ Đã lưu' :
              saveStatus === 'error' ? 'Lỗi lưu' :
              'Đang kết nối'
            }</span>
          </div>
          <button
            className={styles.submitBtn}
            onClick={() => void handleSubmit(false)}
            disabled={isLoading}
          >
            NỘP BÀI
          </button>
          <button
            className={styles.headerIconBtn}
            aria-label="Bật hoặc tắt toàn màn hình"
            onClick={() => {
              if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen?.();
              } else {
                document.exitFullscreen?.();
              }
            }}
          >
            <Maximize size={16} />
          </button>
          <button
            className="theme-toggle"
            aria-label={theme === 'dark' ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            <span className="icon">
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </span>
          </button>
        </div>
      </header>

      <div className={styles.toolbar} role="toolbar" aria-label="Điều khiển làm bài">
        <div className={styles.toolbarGroup}>
          <button className="btn secondary small" onClick={handlePrev} disabled={currentQuestion <= 1} aria-label="Về câu trước">
            Quay lại
          </button>
          <button className="btn small" onClick={handleNext} disabled={currentQuestion >= totalQuestions} aria-label="Sang câu tiếp theo">
            Tiếp theo
          </button>
          <button
            className="btn secondary small"
            onClick={() => setZoom(Math.max(100, zoom - 25))}
            aria-label="Giảm cỡ chữ"
          >
            A-
          </button>
          <button
            className="btn secondary small"
            onClick={() => setZoom(Math.min(150, zoom + 25))}
            aria-label="Tăng cỡ chữ"
          >
            A+
          </button>
          <span className={styles.zoomValue} aria-live="polite">Cỡ chữ {zoom}%</span>
          <button className="btn secondary small" onClick={() => setZoom(100)} aria-label="Đặt lại cỡ chữ 100%">
            Đặt lại
          </button>
        </div>
        <div className={styles.toolbarGroup}>
          <span className={styles.shortcutHint} aria-hidden="true">
            Phím tắt: N/P chuyển câu · M đánh dấu · 1–4 chọn đáp án
          </span>
          <span className={styles.answeredCount} role="status" aria-live="polite">
            Đã trả lời: {answeredCount} / {totalQuestions}
            {markedQuestions.length > 0 && ` · ${markedQuestions.length} đánh dấu`}
          </span>
          <button
            className="btn outline small"
            onClick={() => setShowReviewPanel(true)}
            aria-haspopup="dialog"
          >
            <Eye size={14} aria-hidden="true" /> Xem lại
          </button>
        </div>
      </div>

      {/* Cảnh báo rời khu vực thi (rời tab / thoát toàn màn hình) */}
      {showTabWarning && (
        <div className={styles.tabWarning} role="alert" aria-live="assertive">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>Bạn đã rời khỏi khu vực thi! ({tabSwitchCount} lần)</span>
        </div>
      )}

      <div className={styles.content}>
        <section
          id="exam-question-prompt"
          className={styles.passagePanel}
          aria-label="Nội dung câu hỏi"
          aria-busy={isLoading}
          tabIndex={-1}
        >
          {isLoading ? (
            <div className={styles.emptyState} role="status" aria-live="polite">Đang tải câu hỏi từ Supabase...</div>
          ) : null}
          {!isLoading && questions.length === 0 && !loadError ? (
            <div className={styles.emptyState}>
              Cơ sở dữ liệu chưa có câu hỏi cho phiên thi này.
            </div>
          ) : null}
          {loadError ? (
            <div className={styles.emptyState} role="alert">
              <p className={styles.errorText}>{loadError}</p>
              <button
                className="btn outline small"
                type="button"
                onClick={() => {
                  setLoadError('');
                  setIsLoading(true);
                  setLoadAttempt((attempt) => attempt + 1);
                }}
              >
                Thử tải lại
              </button>
            </div>
          ) : null}
          {saveError ? <p className={styles.errorText} role="alert">{saveError}</p> : null}

          {activeQuestion && renderableQuestion ? (
            <article className={styles.promptCard}>
              <div className={styles.panelLabel}>NỘI DUNG CÂU HỎI</div>
              <QuestionRenderer
                key={activeQuestion.id}
                question={renderableQuestion}
                section="prompt"
              />
              <div className={styles.questionContext}>
                <span>{room?.name ?? 'Phiên thi'}</span>
                <span>{room?.blueprintName ?? room?.subjectName ?? 'Đề thi'}</span>
              </div>
            </article>
          ) : null}
        </section>

        <section
          id="exam-answer-panel"
          className={styles.questionPanel}
          aria-label={`Phần trả lời — Câu ${activeQuestion?.displayNo ?? ''}`}
          tabIndex={-1}
        >
          {activeQuestion && renderableQuestion ? (
            <article className={styles.answerCard}>
              <div className={styles.answerHeader}>
                <div>
                  <div className={styles.panelLabel}>PHẦN TRẢ LỜI</div>
                  <h2>Câu {activeQuestion.displayNo}</h2>
                </div>
                <button
                  type="button"
                  className={`${styles.flagBtn} ${
                    marked.includes(activeQuestion.number) ? styles.marked : ''
                  }`}
                  aria-pressed={marked.includes(activeQuestion.number)}
                  aria-label={
                    marked.includes(activeQuestion.number)
                      ? 'Bỏ đánh dấu câu hỏi'
                      : 'Đánh dấu câu hỏi để xem lại'
                  }
                  onClick={() => toggleMark(activeQuestion.number)}
                >
                  <Flag
                    size={16}
                    fill={
                      marked.includes(activeQuestion.number)
                        ? 'currentColor'
                        : 'none'
                    }
                  />
                </button>
              </div>

              <QuestionRenderer
                key={activeQuestion.id}
                question={renderableQuestion}
                section="answer"
                selectedOptionId={choiceAnswers[activeQuestion.id]}
                trueFalseAnswers={trueFalseAnswers[activeQuestion.id] ?? {}}
                textValue={textAnswers[activeQuestion.id] ?? ''}
                onSelectOption={(optionId, label) =>
                  persistChoice(activeQuestion, optionId, label)
                }
                onTrueFalseChange={(itemId, value) =>
                  persistTrueFalse(activeQuestion, itemId, value)
                }
                onTextChange={(value) => persistTextAnswer(activeQuestion, value)}
                onTextBlur={() => void flush()}
              />
            </article>
          ) : null}
        </section>
      </div>

      <nav className={styles.questionNav} aria-label="Danh sách câu hỏi">
        <div
          className={styles.questionButtons}
          role="listbox"
          aria-label="Chọn câu hỏi"
          aria-orientation="horizontal"
          onKeyDown={(e) => {
            const buttons = Array.from(
              e.currentTarget.querySelectorAll<HTMLButtonElement>('button'),
            );
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            if (index < 0) return;
            let next = -1;
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % buttons.length;
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;
            else if (e.key === 'Home') next = 0;
            else if (e.key === 'End') next = buttons.length - 1;
            if (next >= 0) {
              e.preventDefault();
              buttons[next].focus();
            }
          }}
        >
          {questions.map((question) => {
            const answered =
              Boolean(choiceAnswers[question.id]) ||
              Boolean(textAnswers[question.id]?.trim()) ||
              Object.keys(trueFalseAnswers[question.id] ?? {}).length > 0;
            const isMarked = marked.includes(question.number);
            const isCurrent = question.number === currentQuestion;
            return (
              <button
                key={question.id}
                type="button"
                role="option"
                aria-selected={isCurrent}
                aria-label={`Câu ${question.displayNo}${answered ? ', đã trả lời' : ', chưa trả lời'}${isMarked ? ', đã đánh dấu' : ''}`}
                className={`${styles.qNumber} ${
                  answered ? styles.answered : ''
                } ${isMarked ? styles.marked : ''} ${
                  isCurrent ? styles.current : ''
                }`}
                onClick={() => {
                  setCurrentQuestion(question.number);
                  resetPanelScroll();
                }}
              >
                {question.displayNo}
              </button>
            );
          })}
        </div>
        <div className={styles.legend}>
          <span className={styles.legendItem}>
            <span className={styles.legendDot}></span>Chưa làm
          </span>
          <span className={styles.legendItem}>
            <span className={`${styles.legendDot} ${styles.done}`}></span>Đã làm
          </span>
          <span className={styles.legendItem}>
            <span className={`${styles.legendDot} ${styles.now}`}></span>Đang xem
          </span>
          <span className={styles.legendItem}>
            <span className={`${styles.legendDot} ${styles.mark}`}></span>Đánh dấu
          </span>
        </div>
      </nav>

      {/* Answer Review Panel */}
      {showReviewPanel && (
        <div
          className={styles.reviewOverlay}
          onClick={() => setShowReviewPanel(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setShowReviewPanel(false);
          }}
        >
          <div
            className={styles.reviewPanel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="exam-review-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.reviewHeader}>
              <h2 id="exam-review-title">Xem lại bài làm</h2>
              <button
                className={styles.reviewClose}
                onClick={() => setShowReviewPanel(false)}
                autoFocus
                aria-label="Đóng bảng xem lại"
              >
                <X size={20} aria-hidden="true" />
              </button>
            </div>

            <div className={styles.reviewStats}>
              <div className={styles.reviewStat}>
                <span className={styles.reviewStatNumber}>{answeredCount}</span>
                <span className={styles.reviewStatLabel}>Đã trả lời</span>
              </div>
              <div className={styles.reviewStat}>
                <span className={`${styles.reviewStatNumber} ${styles.statEmpty}`}>{unansweredQuestions.length}</span>
                <span className={styles.reviewStatLabel}>Chưa trả lời</span>
              </div>
              <div className={styles.reviewStat}>
                <span className={`${styles.reviewStatNumber} ${styles.statMarked}`}>{markedQuestions.length}</span>
                <span className={styles.reviewStatLabel}>Đánh dấu</span>
              </div>
            </div>

            {unansweredQuestions.length > 0 && (
              <div className={styles.reviewSection}>
                <h3>Câu chưa trả lời</h3>
                <div className={styles.reviewQuestionList}>
                  {unansweredQuestions.map((q) => (
                    <button
                      key={q.id}
                      className={styles.reviewQuestionBtn}
                      onClick={() => {
                        setShowReviewPanel(false);
                        setCurrentQuestion(q.number);
                        resetPanelScroll();
                      }}
                    >
                      Câu {q.displayNo}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {markedQuestions.length > 0 && (
              <div className={styles.reviewSection}>
                <h3>Câu đánh dấu xem lại</h3>
                <div className={styles.reviewQuestionList}>
                  {markedQuestions.map((q) => (
                    <button
                      key={q.id}
                      className={`${styles.reviewQuestionBtn} ${styles.reviewMarked}`}
                      onClick={() => {
                        setShowReviewPanel(false);
                        setCurrentQuestion(q.number);
                        resetPanelScroll();
                      }}
                    >
                      Câu {q.displayNo}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className={styles.reviewFooter}>
              <p>Thời gian còn lại: <ExamTimeText deadlineMs={deadlineMs} durationSeconds={durationSeconds} /></p>
              <div className={styles.reviewActions}>
                <button className="btn secondary" onClick={() => setShowReviewPanel(false)}>
                  Quay lại làm bài
                </button>
                <button className="btn" onClick={() => void handleConfirmSubmit()}>
                  <CheckCircle size={16} aria-hidden="true" /> Xác nhận nộp bài
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
