// Editable tier catalog for the Tabox pricing page.
//
// To add or change a tier, edit this array and re-run `node build-pricing.mjs`.
// Price IDs come from the Paddle LIVE catalog (immutable amounts — archive+recreate to change).
//
// Shape (informal — this is plain JS, not TypeScript):
//   { name, description, features: string[], priceId: { month, year } }

export const TIERS = [
  {
    name: 'Pro',
    description: 'Everything in Tabox, unlocked.',
    features: [
      'Tabox AI organizes, renames, and arranges for you',
      'Live shared folders for your team',
      'Share any collection with one link',
      'Sync across devices',
    ],
    priceId: {
      month: 'pri_01kxk6xwxdgmtr2eat3xqacs3z', // Tabox Pro — monthly (live)
      year: 'pri_01kxk6xx37e1h9pdjvmvy457br', //  Tabox Pro — annual (live)
    },
    // Same amounts, no 7-day trial — used when the Worker says the visitor's
    // googleId already used its trial (GET /checkout/eligibility).
    priceIdNoTrial: {
      month: 'pri_01m114qdwwa9att8vch4y4eav7', // Tabox Pro — monthly, no trial (live)
      year: 'pri_01m114qe06td8d2471bnyqw9d5', //  Tabox Pro — annual, no trial (live)
    },
    highlighted: true,
  },
];
