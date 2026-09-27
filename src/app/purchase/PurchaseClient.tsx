'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import {
  ArrowRight,
  BadgeCheck,
  BookOpen,
  Check,
  Clock,
  Copy,
  Crown,
  ExternalLink,
  Infinity as InfinityIcon,
  Loader2,
  MessageCircle,
  Minus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Wallet,
} from 'lucide-react';
import { showToast } from '@/components/ui/Toast';
import { createPurchaseOrder } from './actions';
import { createClient } from '@/lib/supabase/client';
import { formatPriceVnd } from '@/lib/supabase/exam-data';
import { formatHanoiDate } from '@/lib/datetime';
import styles from '@/styles/purchase.module.css';
import StudentNav from '@/components/ui/StudentNav';

export type PurchaseProduct = {
  id: string;
  code: string;
  name: string;
  product_kind: 'subscription';
  price_amount: number;
  currency: string;
  // Cột DB có giá trị dummy (999999, "không giới hạn lượt") cho gói subscription
  // — không còn ý nghĩa nghiệp vụ, KHÔNG hiển thị ra UI.
  valid_days: number | null;
};

export type CurrentAccess = {
  is_vip: boolean;
  plan_code: string | null;
  expires_at: string | null;
};

export const PURCHASE_SCOPE_LABEL = 'Dùng cho tất cả phòng thi và tự luyện';

export function describePurchaseValidity(validDays: number | null): string {
  if (!validDays) return 'không giới hạn hạn dùng';
  if (validDays % 365 === 0) {
    const years = validDays / 365;
    return 'hạn ' + years + ' năm';
  }
  if (validDays % 7 === 0 && validDays < 30) {
    return 'hạn ' + validDays / 7 + ' tuần';
  }
  return 'hạn ' + validDays + ' ngày';
}

/** Nhãn thời hạn ngắn gọn cho dòng giá ("1 năm", "30 ngày", "1 tuần"). */
export function durationLabel(validDays: number | null): string {
  return describePurchaseValidity(validDays).replace(/^hạn /, '');
}

/** Tên gói hiển thị sạch (dữ liệu DB thiếu dấu) — suy từ thời hạn, fallback tên gốc. */
export function planDisplayName(product: PurchaseProduct): string {
  const days = product.valid_days;
  if (days === 7) return 'VIP Tuần';
  if (days === 30) return 'VIP Tháng';
  if (days === 365) return 'VIP Năm';
  if (days && days % 365 === 0) return 'VIP ' + days / 365 + ' Năm';
  if (days && days % 30 === 0) return 'VIP ' + days / 30 + ' Tháng';
  if (days && days % 7 === 0) return 'VIP ' + days / 7 + ' Tuần';
  return product.name;
}

/** Đối tượng phù hợp với từng gói, giúp học sinh tự chọn đúng nhu cầu. */
export function planKicker(product: PurchaseProduct): string {
  const days = product.valid_days ?? 0;
  if (days > 0 && days <= 10) return 'Ôn gấp / dùng thử';
  if (days > 10 && days <= 120) return 'Ôn đều theo tháng';
  return 'Trọn mùa thi 2026';
}

/** Giá quy đổi theo ngày, dùng để so sánh giá trị giữa các gói (đồng/ngày). */
export function getPricePerDay(
  product: Pick<PurchaseProduct, 'price_amount' | 'valid_days'>,
): number | null {
  if (!product.valid_days || product.valid_days <= 0) return null;
  return product.price_amount / product.valid_days;
}

export function formatPricePerDay(
  product: Pick<PurchaseProduct, 'price_amount' | 'valid_days'>,
): string {
  const perDay = getPricePerDay(product);
  if (perDay == null) return '';
  return '~' + Math.round(perDay).toLocaleString('vi-VN') + 'đ/ngày';
}

/** % tiết kiệm của 1 gói so với gói có giá/ngày cao nhất (thường là gói tuần). */
export function getSavingsPercent(
  product: PurchaseProduct,
  products: PurchaseProduct[],
): number | null {
  const perDay = getPricePerDay(product);
  if (perDay == null) return null;
  let worstPerDay = 0;
  for (const candidate of products) {
    const candidatePerDay = getPricePerDay(candidate);
    if (candidatePerDay != null && candidatePerDay > worstPerDay) {
      worstPerDay = candidatePerDay;
    }
  }
  if (worstPerDay <= 0 || perDay >= worstPerDay) return null;
  return Math.round((1 - perDay / worstPerDay) * 100);
}

/** Gói tháng là "phổ biến nhất" theo mặc định; nếu bảng giá đổi tên/mã, rơi về gói ở giữa. */
export function getPopularProductId(products: PurchaseProduct[]): string | null {
  const monthly = products.find((product) => product.code === 'VIP-MONTH');
  if (monthly) return monthly.id;
  if (products.length === 0) return null;
  const sorted = [...products].sort((a, b) => a.price_amount - b.price_amount);
  return sorted[Math.floor(sorted.length / 2)]?.id ?? null;
}

/** "Tiết kiệm nhất" = giá/ngày thấp nhất trong các gói đang mở bán. */
export function getBestValueProductId(products: PurchaseProduct[]): string | null {
  let bestId: string | null = null;
  let bestPerDay = Infinity;
  for (const product of products) {
    const perDay = getPricePerDay(product);
    if (perDay != null && perDay < bestPerDay) {
      bestPerDay = perDay;
      bestId = product.id;
    }
  }
  return bestId;
}

// Thanh toán tự động qua VietQR (buildVietQrUrl/qrUrl) đã bật: học viên quét QR để
// chuyển khoản đúng số tiền + nội dung, hệ thống tự cấp key qua webhook/đối soát.
// Zalo bên dưới chỉ là kênh hỗ trợ thủ công khi cần.
export const ZALO_LINK = 'https://zalo.me/0862370152';
export const ZALO_DISPLAY = 'zalo.me/0862370152';

const TERMINAL_ORDER_STATUSES = new Set(['fulfilled', 'failed', 'expired', 'revoked']);

/** Quyền lợi VIP — dùng chung cho mọi gói (chỉ khác thời hạn). */
const PLAN_FEATURES = [
  'Làm toàn bộ đề trong kho',
  'Xem lời giải chi tiết đầy đủ',
  'Làm lại không giới hạn',
  'Chấm điểm tự động tức thì',
];

export function purchaseOrderStatusLabel(status: string) {
  switch (status) {
    case 'pending': return 'Chờ chuyển khoản';
    case 'paid': return 'Đã nhận tiền';
    case 'fulfilled': return 'Đã kích hoạt VIP';
    case 'expired': return 'Đã hết hạn';
    case 'failed': return 'Cần kiểm tra';
    case 'revoked': return 'Đã thu hồi';
    default: return status;
  }
}

export function purchaseErrorLabel(error: string) {
  const labels: Record<string, string> = {
    CHECKOUT_DISABLED: 'Kênh mua VIP đang tạm đóng.',
    CHECKOUT_CONFIGURATION_INVALID: 'Kênh thanh toán chưa sẵn sàng.',
    NOT_AUTHENTICATED: 'Vui lòng đăng nhập trước khi mua VIP.',
    PRODUCT_NOT_AVAILABLE: 'Gói này đã ngừng bán. Hãy chọn gói khác.',
    PRODUCT_LOOKUP_FAILED: 'Chưa tải được thông tin gói. Vui lòng thử lại.',
    PAYMENT_CURRENCY_UNSUPPORTED: 'Gói thanh toán phải sử dụng VND.',
    TRIAL_ALREADY_USED: 'Gói dùng thử chỉ mua 1 lần cho mỗi tài khoản.',
    COUPON_INVALID: 'Mã giảm giá không hợp lệ.',
    COUPON_NOT_FOUND: 'Không tìm thấy mã giảm giá.',
    COUPON_INACTIVE: 'Mã giảm giá đã bị tắt.',
    COUPON_NOT_STARTED: 'Mã giảm giá chưa tới thời gian áp dụng.',
    COUPON_EXPIRED: 'Mã giảm giá đã hết hạn.',
    COUPON_EXHAUSTED: 'Mã giảm giá đã hết lượt dùng.',
    COUPON_MIN_ORDER_NOT_MET: 'Đơn chưa đủ giá trị tối thiểu để dùng mã này.',
    COUPON_PER_USER_LIMIT: 'Bạn đã dùng mã này rồi.',
    COUPON_DISCOUNT_TOO_HIGH: 'Mã giảm giá vượt quá giá trị đơn.',
  };
  return labels[error] ?? error;
}

export type CheckoutBankDetails = {
  bankCode: string;
  bankAccount: string;
};

type OrderState = {
  orderId: string;
  paymentCode: string;
  amount: number;
  currency: string;
  status: string;
  expiresAt: string | null;
};

export type PurchaseClientProps = {
  products: PurchaseProduct[];
  enabled: boolean;
  bankDetails: CheckoutBankDetails | null;
  currentAccess: CurrentAccess | null;
};

export function buildVietQrUrl(
  bankDetails: CheckoutBankDetails,
  order: Pick<OrderState, 'amount' | 'currency' | 'paymentCode'>,
) {
  if (order.currency !== 'VND') return '';

  const bankCode = bankDetails.bankCode.trim().toUpperCase();
  const bankAccount = bankDetails.bankAccount.replace(/\s+/g, '');
  const params = new URLSearchParams({
    amount: String(order.amount),
    addInfo: order.paymentCode,
  });

  return (
    'https://img.vietqr.io/image/' +
    encodeURIComponent(bankCode) +
    '-' +
    encodeURIComponent(bankAccount) +
    '-qr_only.png?' +
    params.toString()
  );
}

type FeatureValue = true | false | string;

const FEATURE_ROWS: Array<{ label: string; free: FeatureValue; vip: FeatureValue }> = [
  { label: 'Xem danh sách đề thi', free: true, vip: true },
  { label: 'Làm đề miễn phí (3 đề/môn)', free: true, vip: true },
  { label: 'Làm toàn bộ đề trong kho', free: false, vip: true },
  { label: 'Chấm điểm tự động', free: true, vip: true },
  { label: 'Xem lời giải chi tiết', free: 'Giới hạn', vip: 'Đầy đủ' },
  { label: 'Làm lại không giới hạn', free: false, vip: true },
];

function FeatureCell({ value }: { value: FeatureValue }) {
  if (typeof value === 'string') return <span>{value}</span>;
  return value ? (
    <Check size={16} className={styles.featureYes} aria-label="Có" />
  ) : (
    <Minus size={16} className={styles.featureNo} aria-label="Không" />
  );
}

function FeatureComparisonTable() {
  return (
    <section className={styles.compareCard} aria-label="So sánh Free và VIP">
      <h2>Free vs VIP — bạn được gì thêm?</h2>
      <div className={styles.compareTable} role="table">
        <div className={styles.compareRow + ' ' + styles.compareHead} role="row">
          <span role="columnheader">Tính năng</span>
          <span role="columnheader">Free</span>
          <span role="columnheader">VIP</span>
        </div>
        {FEATURE_ROWS.map((row) => (
          <div className={styles.compareRow} role="row" key={row.label}>
            <span role="cell">{row.label}</span>
            <span role="cell" className={styles.compareCell}>
              <FeatureCell value={row.free} />
            </span>
            <span role="cell" className={styles.compareCell + ' ' + styles.compareCellVip}>
              <FeatureCell value={row.vip} />
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function PurchaseClient({
  products,
  enabled,
  bankDetails,
  currentAccess,
}: PurchaseClientProps) {
  const router = useRouter();
  const [order, setOrder] = useState<OrderState | null>(null);
  const [selectedProduct, setSelectedProduct] = useState(products[0]?.id ?? '');
  const [coupon, setCoupon] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [copied, setCopied] = useState('');
  const [access, setAccess] = useState<CurrentAccess | null>(currentAccess);

  const selected = useMemo(
    () => products.find((product) => product.id === selectedProduct) ?? null,
    [products, selectedProduct],
  );

  const popularId = useMemo(() => getPopularProductId(products), [products]);
  const bestValueId = useMemo(() => getBestValueProductId(products), [products]);

  const scrollToPricing = useCallback(() => {
    document
      .getElementById('pricing')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const refreshOrder = useCallback(async () => {
    if (!order) return;
    setIsRefreshing(true);
    try {
      const supabase = createClient();
      const { data: latest } = await supabase
        .from('purchase_orders')
        .select('id,status,amount,currency,expires_at')
        .eq('id', order.orderId)
        .maybeSingle();
      if (!latest) return;

      setOrder((current) =>
        current
          ? {
              ...current,
              status: latest.status,
              amount: latest.amount,
              currency: latest.currency,
              expiresAt: latest.expires_at,
            }
          : current,
      );

      if (latest.status === 'fulfilled') {
        // Gói VIP được cấp qua entitlements (không sinh exam_key) — đọc lại
        // hạn VIP mới nhất để hiện đúng ngày hết hạn sau khi cộng dồn.
        const { data: latestAccess } = await supabase.rpc('get_user_access');
        if (latestAccess && typeof latestAccess === 'object') {
          setAccess(latestAccess as CurrentAccess);
        }
      }
    } finally {
      setIsRefreshing(false);
    }
  }, [order]);

  useEffect(() => {
    if (!order || TERMINAL_ORDER_STATUSES.has(order.status)) {
      return;
    }
    const interval = window.setInterval(() => {
      void refreshOrder();
    }, 4000);
    return () => window.clearInterval(interval);
  }, [order, refreshOrder]);

  // Realtime: react the instant the webhook flips the order (poll above is the
  // fallback the MBBank V4 docs recommend running alongside the webhook).
  useEffect(() => {
    if (!order || TERMINAL_ORDER_STATUSES.has(order.status)) return;
    const supabase = createClient();
    const channel = supabase
      .channel('order-' + order.orderId)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'purchase_orders',
          filter: 'id=eq.' + order.orderId,
        },
        () => {
          void refreshOrder();
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [order, refreshOrder]);

  // Live countdown to the 24h payment window so the pressure/urgency is clear.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!order || TERMINAL_ORDER_STATUSES.has(order.status) || !order.expiresAt) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [order]);

  const countdown = useMemo(() => {
    if (!order?.expiresAt) return null;
    const remaining = new Date(order.expiresAt).getTime() - now;
    if (remaining <= 0) return '00:00';
    const totalSeconds = Math.floor(remaining / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    return (hours > 0 ? pad(hours) + ':' : '') + pad(minutes) + ':' + pad(seconds);
  }, [order, now]);

  const copyValue = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard API có thể bị chặn (iframe/quyền): vẫn báo đã copy để không kẹt UI.
      showToast('Không truy cập được clipboard, hãy copy thủ công.', 'warning');
      return;
    }
    setCopied(label);
    window.setTimeout(() => setCopied(''), 1500);
  };

  const handleCreateOrder = async () => {
    if (!selected) return;
    setIsSubmitting(true);
    setFeedback('');
    const idempotencyKey =
      typeof window !== 'undefined' && window.crypto?.randomUUID
        ? window.crypto.randomUUID()
        : 'order-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    const couponCode = coupon.trim().toUpperCase() || undefined;
    // Gói VIP theo thời gian không gắn với 1 key cụ thể (khác cơ chế top-up key
    // cũ) — luôn truyền undefined, cộng dồn hạn VIP được xử lý ở backend.
    const targetKeyId = undefined;
    try {
      const result = await createPurchaseOrder(selected.id, idempotencyKey, couponCode, targetKeyId);
      if (!result.ok) {
        if (result.error === 'NOT_AUTHENTICATED') {
          // A rotated/expired SSR cookie can race the browser session. Refresh
          // it once before asking the user to sign in again.
          const supabase = createClient();
          const { data: refreshed } = await supabase.auth.refreshSession();
          if (refreshed.session) {
            const retry = await createPurchaseOrder(selected.id, idempotencyKey, couponCode, targetKeyId);
            if (retry.ok) {
              if (retry.order.currency !== 'VND') {
                setFeedback(purchaseErrorLabel('PAYMENT_CURRENCY_UNSUPPORTED'));
                return;
              }
              setOrder(retry.order);
              showToast('Đã tạo đơn. Vui lòng chuyển khoản đúng nội dung.', 'success');
              return;
            }
            if (retry.error !== 'NOT_AUTHENTICATED') {
              setFeedback(purchaseErrorLabel(retry.error));
              return;
            }
          }

          router.push('/?redirect=%2Fpurchase', { transitionTypes: ['nav-back'] });
          return;
        }
        setFeedback(purchaseErrorLabel(result.error));
        return;
      }
      if (result.order.currency !== 'VND') {
        setFeedback(purchaseErrorLabel('PAYMENT_CURRENCY_UNSUPPORTED'));
        return;
      }
      setOrder(result.order);
      showToast('Đã tạo đơn. Vui lòng chuyển khoản đúng nội dung.', 'success');
    } catch {
      setFeedback('Không thể tạo đơn. Vui lòng thử lại.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // VietQR tu dong (mo lai) + Zalo fallback giu nguyen.
  const qrUrl = order && bankDetails ? buildVietQrUrl(bankDetails, order) : '';
  const submitLabel = access?.is_vip ? 'Gia hạn thêm' : 'Mua ngay';
  const orderTerminal = order ? TERMINAL_ORDER_STATUSES.has(order.status) : false;

  return (
    <main className={styles.page} id="main">
      <StudentNav />

      {/* ─── Hero ─── */}
      <section className={styles.hero}>
        <div className={styles.heroGlow} aria-hidden="true" />
        <div className={styles.heroContent}>
          <p className={styles.eyebrow}>
            <Crown size={14} aria-hidden="true" />
            Gói thành viên VIP
          </p>
          <h1>
            Mở khóa <span>toàn bộ kho đề thi</span> THPT 2026
          </h1>
          <p>
            Làm không giới hạn mọi đề trong kho, xem lời giải chi tiết từng câu và
            luyện lại thoải mái. Thanh toán qua QR ngân hàng — hệ thống kích hoạt
            VIP ngay khi nhận được tiền.
          </p>
          <div className={styles.heroActions}>
            <button type="button" className="btn" onClick={scrollToPricing}>
              Xem các gói
              <ArrowRight size={16} />
            </button>
            <Link className={styles.secondaryLink} href="/de-thi">
              Xem kho đề thi
            </Link>
          </div>
          <ul className={styles.trustList}>
            <li>
              <BadgeCheck size={15} />
              Kích hoạt tức thì
            </li>
            <li>
              <ShieldCheck size={15} />
              Thanh toán an toàn qua ngân hàng
            </li>
            <li>
              <Clock size={15} />
              Gia hạn cộng dồn thời gian
            </li>
          </ul>
        </div>

        <aside className={styles.heroCard}>
          <div className={styles.heroCardIcon}>
            <Sparkles size={24} />
          </div>
          <p className={styles.heroCardLabel}>QUYỀN LỢI VIP</p>
          <strong>Học không giới hạn</strong>
          <ul>
            <li>
              <Check size={17} />
              Toàn bộ đề trong kho — mọi môn
            </li>
            <li>
              <Check size={17} />
              Lời giải chi tiết từng câu
            </li>
            <li>
              <Check size={17} />
              Làm lại &amp; luyện tập không giới hạn
            </li>
            <li>
              <Check size={17} />
              Chấm điểm tự động, có phân tích
            </li>
          </ul>
          <p className={styles.heroCardNote}>
            <InfinityIcon size={14} />
            Một tài khoản dùng cho tất cả các môn.
          </p>
        </aside>
      </section>

      {access?.is_vip ? (
        <section className={styles.vipBanner} role="status">
          <ShieldCheck size={20} />
          <div>
            <strong>
              Bạn đang là VIP{access.plan_code ? ' (gói ' + access.plan_code + ')' : ''}
            </strong>
            <p>
              Hết hạn ngày <strong>{formatHanoiDate(access.expires_at)}</strong>.
              Mua thêm gói bên dưới để gia hạn — thời gian được cộng dồn vào hạn
              hiện tại.
            </p>
          </div>
        </section>
      ) : null}

      {!enabled ? (
        <section className={styles.notice}>
          <ShieldCheck size={26} />
          <div>
            <h2>Thanh toán đang tạm đóng</h2>
            <p>Quản trị viên chưa bật cấu hình mua VIP. Vui lòng quay lại sau.</p>
          </div>
          <a
            className="btn"
            href={ZALO_LINK}
            target="_blank"
            rel="noopener noreferrer"
          >
            Nhắn Zalo hỗ trợ
          </a>
        </section>
      ) : (
        <>
          {/* ─── Bảng giá ─── */}
          <section className={styles.pricingSection} id="pricing">
            <div className={styles.sectionHeading}>
              <div>
                <p className={styles.sectionEyebrow}>Bảng giá</p>
                <h2>Chọn gói phù hợp với lịch ôn của bạn</h2>
              </div>
              <p>
                Mọi gói đều mở khóa đầy đủ tính năng — chỉ khác thời hạn. Gói dài
                hơn có giá mỗi ngày rẻ hơn nhiều.
              </p>
            </div>

            {products.length === 0 ? (
              <div className={styles.emptyState}>
                <strong>Chưa có gói nào đang mở bán.</strong>
                <span>Vui lòng quay lại sau hoặc liên hệ Zalo để được hỗ trợ.</span>
              </div>
            ) : (
              <div className={styles.products} role="radiogroup" aria-label="Danh sách gói VIP">
                {products.map((product, index) => {
                  const isPopular = product.id === popularId;
                  const isBestValue = product.id === bestValueId;
                  const isSelected = selectedProduct === product.id;
                  const perDay = formatPricePerDay(product);
                  const savings = getSavingsPercent(product, products);
                  return (
                    <button
                      type="button"
                      key={product.id}
                      role="radio"
                      aria-checked={isSelected}
                      id={'purchase-product-' + product.id}
                      tabIndex={isSelected || (!selected && index === 0) ? 0 : -1}
                      className={
                        styles.product +
                        (isPopular || isBestValue ? ' ' + styles.featured : '') +
                        (isSelected ? ' ' + styles.selected : '')
                      }
                      onClick={() => setSelectedProduct(product.id)}
                      onKeyDown={(event) => {
                        let dir = 0;
                        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') dir = 1;
                        else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') dir = -1;
                        else return;
                        event.preventDefault();
                        const nextIndex = (index + dir + products.length) % products.length;
                        const nextProduct = products[nextIndex];
                        setSelectedProduct(nextProduct.id);
                        window.requestAnimationFrame(() =>
                          document.getElementById('purchase-product-' + nextProduct.id)?.focus(),
                        );
                      }}
                    >
                      {isPopular ? (
                        <span className={styles.recommendedBadge}>
                          <Sparkles size={12} />
                          Phổ biến nhất
                        </span>
                      ) : isBestValue ? (
                        <span className={styles.recommendedBadge}>
                          <Wallet size={12} />
                          Tiết kiệm nhất
                        </span>
                      ) : null}

                      <span className={styles.planKicker}>{planKicker(product)}</span>
                      <span className={styles.planName}>{planDisplayName(product)}</span>

                      <span className={styles.priceLine}>
                        <b>{formatPriceVnd(product.price_amount)}</b>
                        <small>/ {durationLabel(product.valid_days)}</small>
                      </span>

                      {perDay ? <span className={styles.planValue}>Chỉ {perDay}</span> : null}
                      {savings ? (
                        <span className={styles.planValue}>Tiết kiệm ~{savings}%</span>
                      ) : null}

                      <span className={styles.planDivider} />

                      {PLAN_FEATURES.map((feature) => (
                        <span className={styles.planFeature} key={feature}>
                          <Check size={15} />
                          {feature}
                        </span>
                      ))}

                      <span className={styles.selectIndicator}>
                        {isSelected ? (
                          <>
                            <Check size={16} />
                            Đang chọn
                          </>
                        ) : (
                          'Chọn gói này'
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {/* ─── Checkout ─── */}
          {products.length > 0 ? (
            <section className={styles.checkoutGrid}>
              <div className={styles.checkoutCard} aria-label="Xác nhận đơn">
                <div className={styles.checkoutHeading}>
                  <span className={styles.stepNumber}>1</span>
                  <div>
                    <p>Xác nhận &amp; thanh toán</p>
                    <h2>Hoàn tất đơn hàng</h2>
                  </div>
                </div>

                <div className={styles.formRow}>
                  <label className={styles.fieldLabel} htmlFor="purchase-coupon">
                    Mã giảm giá <span>(nếu có)</span>
                  </label>
                  <input
                    id="purchase-coupon"
                    className={styles.textInput}
                    value={coupon}
                    onChange={(e) => setCoupon(e.target.value.toUpperCase())}
                    placeholder="VD: THPT30"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={32}
                  />
                </div>

                {selected ? (
                  <div className={styles.orderSummary} aria-live="polite">
                    <div className={styles.summaryPlan}>
                      <div>
                        <span>Gói đã chọn</span>
                        <strong>{planDisplayName(selected)}</strong>
                      </div>
                      <button type="button" onClick={scrollToPricing}>
                        Đổi gói
                      </button>
                    </div>
                    <div className={styles.summaryRow}>
                      <span>Thời hạn</span>
                      <strong>{durationLabel(selected.valid_days)}</strong>
                    </div>
                    <div className={styles.summaryRow}>
                      <span>Phạm vi</span>
                      <strong>{PURCHASE_SCOPE_LABEL}</strong>
                    </div>
                    {coupon.trim() ? (
                      <div className={styles.summaryRow}>
                        <span>Mã giảm giá</span>
                        <strong>{coupon.trim()} — áp dụng khi tạo đơn</strong>
                      </div>
                    ) : null}
                    <div className={styles.summaryRow + ' ' + styles.summaryTotal}>
                      <span>Tổng thanh toán</span>
                      <span className={styles.total}>
                        {formatPriceVnd(selected.price_amount)}
                      </span>
                    </div>
                    {coupon.trim() ? (
                      <small className={styles.summaryNote}>
                        Số tiền cuối cùng (sau giảm giá) sẽ hiển thị trên đơn ngay
                        khi tạo.
                      </small>
                    ) : null}
                  </div>
                ) : null}

                <button
                  type="button"
                  className={'btn ' + styles.submitBtn}
                  onClick={handleCreateOrder}
                  disabled={!selected || isSubmitting}
                  aria-busy={isSubmitting}
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 size={16} className={styles.spinner} aria-hidden="true" />
                      Đang tạo đơn...
                    </>
                  ) : (
                    submitLabel
                  )}
                </button>
                <p className={styles.checkoutAssurance}>
                  <ShieldCheck size={14} />
                  Không lưu thông tin thẻ. Chỉ chuyển khoản ngân hàng.
                </p>
                {feedback ? <p className={styles.error} role="alert">{feedback}</p> : null}
              </div>

              {order ? (
                <div className={styles.paymentCard} aria-label="Thông tin đơn" aria-live="polite">
                  <div className={styles.orderHeader}>
                    <div>
                      <h2>{purchaseOrderStatusLabel(order.status)}</h2>
                      <small>{order.orderId}</small>
                    </div>
                    <button
                      type="button"
                      className={styles.refresh}
                      onClick={() => void refreshOrder()}
                      disabled={isRefreshing}
                      aria-label="Làm mới trạng thái đơn"
                    >
                      <RefreshCw size={16} />
                    </button>
                  </div>

                  {order.status === 'fulfilled' ? (
                    <div className={styles.success}>
                      <span className={styles.successIcon}>
                        <Check size={22} />
                      </span>
                      <div>
                        <strong>Đã kích hoạt VIP</strong>
                        <small>
                          Hết hạn ngày{' '}
                          <strong>{formatHanoiDate(access?.expires_at ?? null)}</strong>. Vào
                          ngay để làm bài không giới hạn.
                        </small>
                        <Link className="btn" href="/de-thi">
                          Đi đến kho đề thi
                        </Link>
                      </div>
                    </div>
                  ) : orderTerminal ? (
                    <div className={styles.terminalOrder} role="status">
                      <ShieldCheck size={22} />
                      <div>
                        <strong>{purchaseOrderStatusLabel(order.status)}</strong>
                        <p>
                          Đơn không còn nhận thanh toán. Hãy tạo đơn mới và dùng
                          đúng nội dung chuyển khoản.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className={styles.transfer}>
                        {qrUrl ? (
                          <div className={styles.qrFrame}>
                            <Image
                              src={qrUrl}
                              alt="QR chuyển khoản mua VIP"
                              width={220}
                              height={220}
                              unoptimized
                            />
                            <span>Quét bằng app ngân hàng</span>
                          </div>
                        ) : null}
                        <div className={styles.transferDetails}>
                          <InfoRow label="Ngân hàng" value={bankDetails?.bankCode ?? ''} />
                          <InfoRow
                            label="Số tài khoản"
                            value={bankDetails?.bankAccount ?? ''}
                            onCopy={() =>
                              void copyValue(bankDetails?.bankAccount ?? '', 'account')
                            }
                            copied={copied === 'account'}
                          />
                          <InfoRow
                            label="Số tiền"
                            value={order.amount.toLocaleString('vi-VN') + ' ' + order.currency}
                            onCopy={() => void copyValue(String(order.amount), 'amount')}
                            copied={copied === 'amount'}
                          />
                          <InfoRow
                            label="Nội dung"
                            value={order.paymentCode}
                            onCopy={() => void copyValue(order.paymentCode, 'content')}
                            copied={copied === 'content'}
                          />
                        </div>
                      </div>
                      <div className={styles.paymentNotice}>
                        <BadgeCheck size={18} />
                        <p>
                          <strong>Xác nhận tức thì</strong>
                          Hệ thống nhận tiền qua webhook và tự đối soát mỗi 4 giây.
                          Chuyển đúng số tiền và giữ nguyên nội dung.
                        </p>
                      </div>
                      {countdown ? (
                        <p className={styles.expiry} aria-live="off">
                          <Clock size={14} />
                          Đơn còn hiệu lực: <strong>{countdown}</strong>
                        </p>
                      ) : null}
                      <button
                        type="button"
                        className="btn outline"
                        onClick={() => void refreshOrder()}
                        disabled={isRefreshing}
                      >
                        <RefreshCw size={16} />
                        {isRefreshing ? 'Đang kiểm tra...' : 'Đã chuyển, kiểm tra ngay'}
                      </button>
                    </>
                  )}
                </div>
              ) : (
                <div className={styles.guideCard}>
                  <ol className={styles.steps}>
                    <li>
                      <span>
                        <Sparkles size={18} />
                      </span>
                      <div>
                        <strong>Chọn gói VIP</strong>
                        <p>Chọn gói theo thời hạn phù hợp với lịch ôn của bạn.</p>
                      </div>
                    </li>
                    <li>
                      <span>
                        <Wallet size={18} />
                      </span>
                      <div>
                        <strong>Tạo đơn &amp; quét QR</strong>
                        <p>Chuyển khoản đúng số tiền và nội dung hiển thị trên đơn.</p>
                      </div>
                    </li>
                    <li>
                      <span>
                        <BookOpen size={18} />
                      </span>
                      <div>
                        <strong>Kích hoạt &amp; học ngay</strong>
                        <p>VIP được bật tự động — vào kho đề làm bài không giới hạn.</p>
                      </div>
                    </li>
                  </ol>
                  <div className={styles.supportBox}>
                    <div>
                      <MessageCircle size={20} />
                      <div>
                        <strong>Cần hỗ trợ mua VIP?</strong>
                        <p>
                          Chuyển khoản khó hoặc muốn mua thủ công? Nhắn Zalo, bọn
                          mình hỗ trợ nhanh.
                        </p>
                      </div>
                    </div>
                    <a href={ZALO_LINK} target="_blank" rel="noopener noreferrer">
                      <MessageCircle size={16} />
                      Nhắn Zalo {ZALO_DISPLAY}
                      <ExternalLink size={14} />
                    </a>
                  </div>
                </div>
              )}
            </section>
          ) : null}

          {/* ─── Trust ─── */}
          <section className={styles.bottomTrust} aria-label="Cam kết dịch vụ">
            <div>
              <BadgeCheck size={22} />
              <span>
                <strong>Kích hoạt tức thì</strong>
                Nhận tiền là bật VIP ngay, không chờ đợi.
              </span>
            </div>
            <div>
              <Clock size={22} />
              <span>
                <strong>Gia hạn cộng dồn</strong>
                Mua thêm khi đang VIP sẽ cộng dồn thời gian.
              </span>
            </div>
            <div>
              <MessageCircle size={22} />
              <span>
                <strong>Hỗ trợ tận nơi</strong>
                <a href={ZALO_LINK} target="_blank" rel="noopener noreferrer">
                  Nhắn Zalo khi cần trợ giúp
                </a>
              </span>
            </div>
          </section>

          <FeatureComparisonTable />
        </>
      )}
    </main>
  );
}

function InfoRow({
  label,
  value,
  onCopy,
  copied,
}: {
  label: string;
  value: string;
  onCopy?: () => void;
  copied?: boolean;
}) {
  return (
    <div className={styles.infoRow}>
      <span>{label}</span>
      <strong>{value || '—'}</strong>
      {onCopy ? (
        <button type="button" onClick={onCopy} aria-label={'Copy ' + label}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      ) : null}
    </div>
  );
}
