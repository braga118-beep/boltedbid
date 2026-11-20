// BoltedBid plans. Prices are in US dollars.
// When your checkout links are ready (Stripe Payment Links, for example), paste them between the quotes.
// The front page and the app both read this file.
window.BB_PLANS = {
  trialDays: 30,
  monthly: { name: 'Monthly', price: 15, per: 'month', link: '' },
  yearly: { name: 'Yearly', price: 130, per: 'year', link: '' },
  support: '' // optional: the email address customers should contact, for example support@boltedbid.com
};
