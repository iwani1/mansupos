import { openBrowser, recordFailure, testBase as base } from './browser-helpers.mjs';

const { browser, page, pageErrors } = await openBrowser();
try {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('.product-card').first().waitFor();
  const enabled = await page.evaluate(() => {
    const style = getComputedStyle(document.querySelector('.product-card'));
    return { name: style.animationName, duration: style.animationDuration, transition: style.transitionDuration };
  });
  // The counter is task-first, not an editorial entrance sequence. Feedback can
  // fade briefly, but product cards must never wait for an animation to finish.
  if (enabled.name !== 'none' || enabled.transition.split(',').some(value => parseFloat(value) > 0.2)) {
    throw new Error(`Counter motion is too distracting: ${JSON.stringify(enabled)}`);
  }

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await page.evaluate(() => {
    const style = getComputedStyle(document.querySelector('.product-card'));
    return { name: style.animationName, duration: style.animationDuration, transition: style.transitionDuration };
  });
  if (reduced.name !== 'none' || parseFloat(reduced.duration) !== 0 || parseFloat(reduced.transition) !== 0) throw new Error('Reduced-motion preference did not disable animation/transition.');
  if (pageErrors.length) throw new Error(pageErrors.join('\n'));
  console.log('PASS: no decorative product entrance; subtle feedback and reduced-motion disablement.');
} catch (error) {
  await recordFailure(page, error, 'motion-failure', pageErrors);
  process.exitCode = 1;
} finally { await browser.close(); }
