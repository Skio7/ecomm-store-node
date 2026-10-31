/**
 * Demo accounts shared across services so seeded data (addresses, orders,
 * reviews) lines up with the users the auth service creates. Passwords live
 * only in the auth service seed.
 */
export const SEED_USERS = Object.freeze([
  { id: 'usr_seed_admin', email: 'admin@shop.test', name: 'Asha Admin', role: 'admin' },
  { id: 'usr_seed_jane', email: 'jane@shop.test', name: 'Jane Doe', role: 'customer' },
  { id: 'usr_seed_rahul', email: 'rahul@shop.test', name: 'Rahul Sharma', role: 'customer' },
]);
