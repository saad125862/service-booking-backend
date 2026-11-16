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
const img = (name) => `https://images.unsplash.com/photo-${PHOTOS[name]}?w=800&q=70&auto=format&fit=crop`;

// [name, category, price, durationMinutes, isFeatured, description]
const SERVICES = [
  ['Swedish Massage', 'Wellness', 60, 60, true, 'A relaxing full-body massage using long, flowing strokes to ease tension and improve circulation.'],
  ['Deep Tissue Massage', 'Wellness', 85, 90, false, 'Firm-pressure massage targeting chronic muscle tightness, ideal for athletes and desk workers.'],
  ['Aromatherapy Session', 'Wellness', 55, 45, false, 'Calming essential-oil treatment designed to reduce stress and improve sleep quality.'],
  ['Classic Facial', 'Beauty', 45, 45, true, 'Deep cleansing, exfoliation and hydration facial for fresh, glowing skin.'],
  ['Haircut & Styling', 'Beauty', 35, 45, false, 'Consultation, precision cut, wash and blow-dry with a stylist of your choice.'],
  ['Manicure & Pedicure', 'Beauty', 50, 60, false, 'Complete nail care: shaping, cuticle care, massage and polish for hands and feet.'],
  ['Bridal Makeup', 'Beauty', 120, 90, true, 'Long-lasting, photo-ready bridal makeup including a short trial consultation.'],
  ['Home Deep Cleaning', 'Home Services', 90, 120, false, 'Top-to-bottom cleaning of your home with eco-friendly products and professional equipment.'],
  ['AC Maintenance', 'Home Services', 55, 60, false, 'Filter cleaning, gas-level check and performance inspection for split and window units.'],
  ['Plumbing Repair Visit', 'Home Services', 40, 60, false, 'On-site diagnosis and repair of leaks, blockages and fixture problems (parts extra).'],
  ['Personal Training Session', 'Fitness', 45, 60, true, 'One-on-one workout tailored to your goals with a certified personal trainer.'],
  ['Private Yoga Class', 'Fitness', 40, 60, false, 'A private yoga session adapted to your level, focusing on flexibility and mindfulness.'],
  ['Career Coaching', 'Consulting', 70, 45, false, 'Structured coaching on CV, interviews and career direction with an experienced mentor.'],
  ['Nutrition Consultation', 'Consulting', 30, 30, false, 'Personalised eating plan and habit advice from a qualified nutritionist.'],
];

async function main() {
  for (const [name, category, price, durationMinutes, isFeatured, description] of SERVICES) {
    const data = { description, price, durationMinutes, imageUrl: img(name), category, isFeatured };
    await prisma.service.upsert({ where: { name }, update: data, create: { name, ...data } });
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

  console.log(`Seeded ${SERVICES.length} services and the demo user.`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
