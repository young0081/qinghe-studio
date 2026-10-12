import { expect } from '@playwright/test';

export async function moveSlider(page, slider, value, { wait = true } = {}) {
  await expect(slider).toBeEnabled();
  await slider.scrollIntoViewIfNeeded();
  const minimum = Number(await slider.getAttribute('min'));
  const maximum = Number(await slider.getAttribute('max'));
  const bounds = await slider.boundingBox();
  await page.mouse.click(bounds.x + 6 + (bounds.width - 12) * (value - minimum) / (maximum - minimum), bounds.y + bounds.height / 2);
  if (wait) await expect(page.locator('.workspace-reasoning')).toHaveAttribute('aria-busy', 'false');
  await expect(slider).toHaveValue(String(value));
}

export async function setReasoning(page, effort, options) {
  const slider = page.getByRole('slider', { name: '思考强度', exact: true });
  const choices = await slider.getAttribute('max') === '6' ? ['default', 'disabled', 'adaptive', 'low', 'medium', 'high', 'max'] : ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const index = choices.indexOf(effort);
  if (index < 0) throw new Error(`Unsupported test effort ${effort}`);
  await moveSlider(page, slider, index, options);
}
