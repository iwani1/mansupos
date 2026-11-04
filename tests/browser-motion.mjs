import { openBrowser, recordFailure, testBase as base } from './browser-helpers.mjs';

const { browser, page, pageErrors } = await openBrowser();
try {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('.product-card').first().waitFor();
  const enabled = await page.evaluate(() => {
    const style = getComputedStyle(document.querySelector('.product-card'));
    return { name: style.animationName, duration: style.animationDuration };
  });
  if (enabled.name === 'none' || parseFloat(enabled.duration) === 0) throw new Error('Product entrance motion is missing under no-preference.');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await page.evaluate(() => {
    const style = getComputedStyle(document.querySelector('.product-card'));
    return { name: style.animationName, duration: style.animationDuration, transition: style.transitionDuration };
  });
  if (reduced.name !== 'none' || parseFloat(reduced.duration) !== 0 || parseFloat(reduced.transition) !== 0) throw new Error('Reduced-motion preference did not disable animation/transition.');
  if (pageErrors.length) throw new Error(pageErrors.join('\n'));
  console.log('PASS: editorial motion enabled by default and fully disabled for prefers-reduced-motion.');
} catch (error) {
  await recordFailure(page, error, 'motion-failure', pageErrors);
  process.exitCode = 1;
} finally { await browser.close(); }
