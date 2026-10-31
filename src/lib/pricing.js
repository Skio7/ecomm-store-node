import { errors } from './errors.js';

/** All money values are integers in minor units (paise). */
export const PRICING = Object.freeze({
  currency: 'INR',
  taxRate: 0.18,
  freeShippingThreshold: 99_900,
  shippingFee: 4_900,
});

export const COUPONS = Object.freeze({
  WELCOME10: { code: 'WELCOME10', type: 'percent', value: 10, maxDiscount: 50_000, description: '10% off (up to ₹500)' },
  FLAT200: { code: 'FLAT200', type: 'flat', value: 20_000, minSubtotal: 149_900, description: '₹200 off orders above ₹1,499' },
  FREESHIP: { code: 'FREESHIP', type: 'shipping', description: 'Free shipping on any order' },
});

export function findCoupon(code) {
  if (!code) return undefined;
  return COUPONS[String(code).trim().toUpperCase()];
}

/** Single source of truth for cart estimates and order totals. */
export function calculateTotals(subtotal, couponCode) {
  let discount = 0;
  let freeShipping = subtotal >= PRICING.freeShippingThreshold;
  let coupon;

  if (couponCode) {
    coupon = findCoupon(couponCode);
    if (!coupon) throw errors.unprocessable(`Coupon "${couponCode}" is not valid`, 'INVALID_COUPON');
    if (coupon.minSubtotal && subtotal < coupon.minSubtotal) {
      throw errors.unprocessable(`Coupon ${coupon.code} requires a minimum order of ₹${coupon.minSubtotal / 100}`, 'INVALID_COUPON');
    }
    if (coupon.type === 'percent') discount = Math.min(Math.round((subtotal * coupon.value) / 100), coupon.maxDiscount ?? Infinity);
    if (coupon.type === 'flat') discount = Math.min(coupon.value, subtotal);
    if (coupon.type === 'shipping') freeShipping = true;
  }

  const shipping = subtotal === 0 || freeShipping ? 0 : PRICING.shippingFee;
  const tax = Math.round((subtotal - discount) * PRICING.taxRate);
  return {
    subtotal,
    discount,
    shipping,
    tax,
    total: subtotal - discount + shipping + tax,
    currency: PRICING.currency,
    couponCode: coupon?.code ?? null,
  };
}
