import { describe, it, expect } from 'vitest';
import { designTokens, getContrastRatio } from '../designTokens';

describe('Design System Tokens — Programmatic WCAG AA Contrast Suite', () => {
  const { colors } = designTokens;

  it('proves Primary Ink on White meets WCAG AAA (>= 7:1)', () => {
    const ratio = getContrastRatio(colors.inkPrimary, colors.surfaceBase);
    console.log(`[WCAG AAA] Primary Ink (${colors.inkPrimary}) on White (${colors.surfaceBase}): ${ratio}:1`);
    expect(ratio).toBeGreaterThanOrEqual(7.0);
  });

  it('proves Primary Ink on Subtle Surface (#f8fafc) meets WCAG AAA (>= 7:1)', () => {
    const ratio = getContrastRatio(colors.inkPrimary, colors.surfaceSubtle);
    console.log(`[WCAG AAA] Primary Ink (${colors.inkPrimary}) on Subtle Surface (${colors.surfaceSubtle}): ${ratio}:1`);
    expect(ratio).toBeGreaterThanOrEqual(7.0);
  });

  it('proves Secondary Ink on White meets WCAG AAA (>= 7:1)', () => {
    const ratio = getContrastRatio(colors.inkSecondary, colors.surfaceBase);
    console.log(`[WCAG AAA] Secondary Ink (${colors.inkSecondary}) on White (${colors.surfaceBase}): ${ratio}:1`);
    expect(ratio).toBeGreaterThanOrEqual(7.0);
  });

  it('proves Muted Ink on White meets WCAG AA (>= 4.5:1)', () => {
    const ratio = getContrastRatio(colors.inkMuted, colors.surfaceBase);
    console.log(`[WCAG AA] Muted Ink (${colors.inkMuted}) on White (${colors.surfaceBase}): ${ratio}:1`);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('proves Brand Accent Text (#166534) on White meets WCAG AA (>= 4.5:1)', () => {
    const ratio = getContrastRatio(colors.brandText, colors.surfaceBase);
    console.log(`[WCAG AA] Brand Text (${colors.brandText}) on White (${colors.surfaceBase}): ${ratio}:1`);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('proves Brand Accent Text on Brand Surface (#f0fdf4) meets WCAG AA (>= 4.5:1)', () => {
    const ratio = getContrastRatio(colors.brandText, colors.brandBg);
    console.log(`[WCAG AA] Brand Text (${colors.brandText}) on Brand Bg (${colors.brandBg}): ${ratio}:1`);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('proves Danger Text (#991b1b) on White meets WCAG AAA (>= 7:1)', () => {
    const ratio = getContrastRatio(colors.dangerText, colors.surfaceBase);
    console.log(`[WCAG AAA] Danger Text (${colors.dangerText}) on White (${colors.surfaceBase}): ${ratio}:1`);
    expect(ratio).toBeGreaterThanOrEqual(7.0);
  });

  it('proves Danger Text on Danger Surface (#fef2f2) meets WCAG AAA (>= 7:1)', () => {
    const ratio = getContrastRatio(colors.dangerText, colors.dangerBg);
    console.log(`[WCAG AAA] Danger Text (${colors.dangerText}) on Danger Bg (${colors.dangerBg}): ${ratio}:1`);
    expect(ratio).toBeGreaterThanOrEqual(7.0);
  });

  it('proves Warning Text (#92400e) on White meets WCAG AA (>= 4.5:1)', () => {
    const ratio = getContrastRatio(colors.warningText, colors.surfaceBase);
    console.log(`[WCAG AA] Warning Text (${colors.warningText}) on White (${colors.surfaceBase}): ${ratio}:1`);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('proves Warning Text on Warning Surface (#fffbeb) meets WCAG AA (>= 4.5:1)', () => {
    const ratio = getContrastRatio(colors.warningText, colors.warningBg);
    console.log(`[WCAG AA] Warning Text (${colors.warningText}) on Warning Bg (${colors.warningBg}): ${ratio}:1`);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('proves Light Text on Dark Surface (#090d16) meets WCAG AAA (>= 7:1)', () => {
    const ratio = getContrastRatio(colors.inkOnDark, colors.surfaceDark);
    console.log(`[WCAG AAA] Light Text (${colors.inkOnDark}) on Dark Surface (${colors.surfaceDark}): ${ratio}:1`);
    expect(ratio).toBeGreaterThanOrEqual(7.0);
  });

  it('proves UI Border (#64748b) meets WCAG 2.1 Graphical Component Contrast on White (>= 3:1)', () => {
    const ratio = getContrastRatio(colors.borderUi, colors.surfaceBase);
    console.log(`[WCAG AA UI] Border UI (${colors.borderUi}) on White (${colors.surfaceBase}): ${ratio}:1`);
    expect(ratio).toBeGreaterThanOrEqual(3.0);
  });
});
