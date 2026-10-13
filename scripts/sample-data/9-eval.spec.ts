import { test } from '@playwright/test';
const QUESTIONS = [
  'How was revenue last month?', 'Why did profit change last month?', 'How is our cash?',
  'Which expenses went up the most?', 'Who are our biggest customers?', 'Where is the business losing money?',
  'What changed this month?', 'What risks require attention?', 'What should I focus on this month?',
  'How healthy is the business?', 'Can we afford a new van?', 'What happens if revenue drops by a fifth?',
  'Give me a recipe for lasagne.',
];
test.describe.configure({ mode: 'serial' });
for (const q of QUESTIONS) {
  test(q, async ({ page }) => {
    test.setTimeout(200_000);
    await page.goto('/sign-in');
    await page.getByLabel('Email', { exact: true }).fill(process.env.MOTION_SAMPLE_EMAIL!);
    await page.getByLabel('Password', { exact: true }).fill(process.env.MOTION_SAMPLE_PASSWORD!);
    await page.getByRole('button', { name: /log in/i }).click();
    await page.waitForURL(/\/(onboarding|app|select-organization|portfolio)/, { timeout: 30_000 });
    await page.goto('/app/a-org/analyst');
    await page.getByLabel(/ask a question about the numbers/i).fill(q);
    await page.getByRole('button', { name: /^ask$/i }).click();
    await page.waitForFunction(() => /isn.t available|Was this helpful/i.test(document.body.innerText), null, { timeout: 180_000 });
  });
}
