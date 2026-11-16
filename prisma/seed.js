import bcrypt from 'bcryptjs';
import { prisma } from '../src/db/prisma.js';
import { BCRYPT_COST } from '../src/config/constants.js';

// Photos from Unsplash (free to use), one that matches each service.
const PHOTOS = {
  'Swedish Massage': '1544161515-4ab6ce6db874',
  'Deep Tissue Massage': '1519823551278-64ac92734fb1',
  'Aromatherapy Session': '1600334129128-685c5582fd35',
  'Classic Facial': '1570172619644-dfd03ed5d881',
  'Haircut & Styling': '1560066984-138dadb4c035',
  'Manicure & Pedicure': '1604654894610-df63bc536371',
  'Bridal Makeup': '1487412947147-5cebf100ffc2',
  'Home Deep Cleaning': '1581578731548-c64695cc6952',
  'AC Maintenance': '1558618666-fcd25c85cd64',
  'Plumbing Repair Visit': '1585704032915-c3400ca199e7',
  'Personal Training Session': '1534438327276-14e5300c3a48',
  'Private Yoga Class': '1544367567-0f2fcb009e0b',
  'Career Coaching': '1573496359142-b8d87734a5a2',
  'Nutrition Consultation': '1490645935967-10de6ba17061',
};
// Payment options offered to customers. The mobile numbers are placeholders: an admin edits
// them (and can add or disable methods) from the admin screens.
const PAYMENT_METHODS = [
  { code: 'cash', name: 'Cash on service', type: 'cash', sortOrder: 1, requiresReference: false, instructions: 'Pay the provider in cash when the service is done.' },
  { code: 'card', name: 'Card on service', type: 'card', sortOrder: 2, requiresReference: false, instructions: "Pay by debit or credit card on the provider's card machine." },
  { code: 'bkash', name: 'bKash', type: 'mobile_wallet', sortOrder: 3, requiresReference: true, accountNumber: '01700-000000', instructions: 'Send the amount to 01700-000000 (Personal), then enter the bKash transaction ID.' },
  { code: 'sslcommerz', name: 'Pay online (SSLCommerz)', type: 'card', sortOrder: 5, requiresReference: false, gatewayProvider: 'sslcommerz', instructions: 'Pay securely online with a card, bKash, Nagad or Rocket. You get a payment link after booking.' },
  { code: 'aamarpay', name: 'Pay online (aamarPay)', type: 'card', sortOrder: 6, requiresReference: false, gatewayProvider: 'aamarpay', instructions: 'Pay securely online with a card or mobile wallet. You get a payment link after booking.' },
  { code: 'demo_gateway', name: 'Pay online (demo checkout)', type: 'card', sortOrder: 7, requiresReference: false, gatewayProvider: 'mock', instructions: 'A pretend online checkout for demos. No real money moves.' },
  { code: 'nagad', name: 'Nagad', type: 'mobile_wallet', sortOrder: 4, requiresReference: true, accountNumber: '01800-000000', instructions: 'Send the amount to 01800-000000 (Personal), then enter the Nagad transaction ID.' },
];

// Example custom fields for the admin's dynamic add-service form (admins can add more).
const SERVICE_FIELDS = [
  { key: 'staff_level', label: 'Specialist level', type: 'select', options: ['Standard', 'Senior specialist'], required: false, sortOrder: 1 },
  { key: 'materials_included', label: 'Materials included', type: 'boolean', required: false, sortOrder: 2 },
  { key: 'what_to_expect', label: 'What to expect', type: 'textarea', required: false, sortOrder: 3 },
];

// Values for those fields on some demo services.
const ATTRIBUTES = {
  'Swedish Massage': { staff_level: 'Senior specialist', materials_included: true, what_to_expect: 'Warm oils, soft music and a full-body relaxing massage. Please arrive 5 minutes early.' },
  'Classic Facial': { staff_level: 'Senior specialist', materials_included: true },
  'Home Deep Cleaning': { staff_level: 'Standard', materials_included: true, what_to_expect: 'A team of two brings equipment and eco-friendly products. Please clear fragile items.' },
  'Plumbing Repair Visit': { staff_level: 'Standard', materials_included: false, what_to_expect: 'Diagnosis and repair on the spot. Replacement parts are charged separately.' },
  'Personal Training Session': { staff_level: 'Senior specialist', materials_included: false },
};

const img = (name) => `https://images.unsplash.com/photo-${PHOTOS[name]}?w=800&q=70&auto=format&fit=crop`;

// [name, category, price in BDT (Bangladeshi taka), durationMinutes, isFeatured, description]
const SERVICES = [
  ['Swedish Massage', 'Wellness', 2500, 60, true, 'A relaxing full-body massage using long, flowing strokes to ease tension and improve circulation.'],
  ['Deep Tissue Massage', 'Wellness', 3500, 90, false, 'Firm-pressure massage targeting chronic muscle tightness, ideal for athletes and desk workers.'],
  ['Aromatherapy Session', 'Wellness', 2200, 45, false, 'Calming essential-oil treatment designed to reduce stress and improve sleep quality.'],
  ['Classic Facial', 'Beauty', 1800, 45, true, 'Deep cleansing, exfoliation and hydration facial for fresh, glowing skin.'],
  ['Haircut & Styling', 'Beauty', 600, 45, false, 'Consultation, precision cut, wash and blow-dry with a stylist of your choice.'],
  ['Manicure & Pedicure', 'Beauty', 1200, 60, false, 'Complete nail care: shaping, cuticle care, massage and polish for hands and feet.'],
  ['Bridal Makeup', 'Beauty', 15000, 90, true, 'Long-lasting, photo-ready bridal makeup including a short trial consultation.'],
  ['Home Deep Cleaning', 'Home Services', 4500, 120, false, 'Top-to-bottom cleaning of your home with eco-friendly products and professional equipment.'],
  ['AC Maintenance', 'Home Services', 1500, 60, false, 'Filter cleaning, gas-level check and performance inspection for split and window units.'],
  ['Plumbing Repair Visit', 'Home Services', 800, 60, false, 'On-site diagnosis and repair of leaks, blockages and fixture problems (parts extra).'],
  ['Personal Training Session', 'Fitness', 1500, 60, true, 'One-on-one workout tailored to your goals with a certified personal trainer.'],
  ['Private Yoga Class', 'Fitness', 1200, 60, false, 'A private yoga session adapted to your level, focusing on flexibility and mindfulness.'],
  ['Career Coaching', 'Consulting', 2000, 45, false, 'Structured coaching on CV, interviews and career direction with an experienced mentor.'],
  ['Nutrition Consultation', 'Consulting', 1000, 30, false, 'Personalised eating plan and habit advice from a qualified nutritionist.'],
];

// By default the seed only creates what is missing, so edits made through the admin screens
// survive container restarts. Run with SEED_FORCE=true to overwrite the demo services
// (prices, photos, descriptions) with the values below.
const FORCE = process.env.SEED_FORCE === 'true';

async function main() {
  for (const [name, category, price, durationMinutes, isFeatured, description] of SERVICES) {
    const data = { description, price, durationMinutes, imageUrl: img(name), category, isFeatured, attributes: ATTRIBUTES[name] ?? {} };
    await prisma.service.upsert({ where: { name }, update: FORCE ? data : {}, create: { name, ...data } });
  }

  for (const field of SERVICE_FIELDS) {
    await prisma.serviceField.upsert({ where: { key: field.key }, update: FORCE ? field : {}, create: field });
  }
  for (const method of PAYMENT_METHODS) {
    await prisma.paymentMethod.upsert({ where: { code: method.code }, update: FORCE ? method : {}, create: method });
  }

  // Demo account for reviewers (documented in the README).
  await prisma.user.upsert({
    where: { email: 'demo@example.com' },
    update: {},
    create: {
      name: 'Demo User',
      email: 'demo@example.com',
      passwordHash: await bcrypt.hash('Demo@1234', BCRYPT_COST),
    },
  });

  // Demo admin for reviewers (documented in the README). Never created through public sign-up.
  await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: { role: 'admin' },
    create: {
      name: 'Admin User',
      email: 'admin@example.com',
      role: 'admin',
      passwordHash: await bcrypt.hash('Admin@1234', BCRYPT_COST),
    },
  });

  console.log(
    `Seeded ${SERVICES.length} services${FORCE ? ' (overwritten)' : ''}, the demo customer and the demo admin.`,
  );
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
