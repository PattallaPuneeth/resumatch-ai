/**
 * ResuMatch AI Design System Tokens
 * Strictly adhering to WCAG 2.1 AA (4.5:1 for normal text, 3:1 for UI components).
 */

export interface ColorToken {
  name: string;
  hex: string;
  description: string;
}

export const designTokens = {
  colors: {
    // Surfaces
    surfaceBase: '#ffffff',
    surfaceSubtle: '#f8fafc',
    surfaceMuted: '#f1f5f9',
    surfaceDark: '#090d16',
    surfaceElevated: '#ffffff',

    // Inks / Text
    inkPrimary: '#090d16',    // Deep slate-950 (19.8:1 on white)
    inkSecondary: '#334155',  // Slate-700 (9.4:1 on white)
    inkMuted: '#475569',      // Slate-600 (7.0:1 on white)
    inkOnDark: '#f8fafc',     // Slate-50 on surfaceDark (19.1:1)

    // Brand Accent (Deep Green)
    brandText: '#166534',     // Emerald-800 (6.5:1 on white)
    brandUi: '#15803d',       // Emerald-700 (4.64:1 on white)
    brandBg: '#f0fdf4',       // Emerald-50
    brandBorder: '#bbf7d0',   // Emerald-200

    // Semantic - Danger / Error / Deletion
    dangerText: '#991b1b',    // Red-800 (8.6:1 on white)
    dangerUi: '#b91c1c',      // Red-700 (7.2:1 on white)
    dangerBg: '#fef2f2',      // Red-50
    dangerBorder: '#fecaca',  // Red-200

    // Semantic - Warning
    warningText: '#92400e',   // Amber-800 (6.3:1 on white)
    warningUi: '#b45309',     // Amber-700 (4.8:1 on white)
    warningBg: '#fffbeb',     // Amber-50
    warningBorder: '#fde68a', // Amber-200

    // Semantic - Info / Neutral
    infoText: '#1e40af',      // Blue-800 (7.8:1 on white)
    infoBg: '#eff6ff',        // Blue-50
    infoBorder: '#bfdbfe',    // Blue-200

    // Borders & Dividers
    borderSubtle: '#e2e8f0',  // Slate-200 (decorative)
    borderUi: '#64748b',      // Slate-500 (4.77:1 UI component contrast on white, >= 3:1)
    borderDark: '#334155',    // Slate-700

    // Focus Ring
    focusRing: '#16a34a',     // Green-600
  },

  typography: {
    fontFamily: {
      sans: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    },
    scale: {
      xs: '0.75rem',    // 12px
      sm: '0.875rem',   // 14px
      base: '1rem',      // 16px
      lg: '1.125rem',   // 18px
      xl: '1.25rem',    // 20px
      '2xl': '1.5rem',  // 24px
      '3xl': '1.875rem',// 30px
      '4xl': '2.25rem', // 36px
    },
    lineHeights: {
      tight: '1.2',
      normal: '1.5',
      relaxed: '1.625',
    },
  },

  radii: {
    sm: '0.25rem',  // 4px
    md: '0.375rem', // 6px
    lg: '0.5rem',   // 8px
    xl: '0.75rem',  // 12px
    '2xl': '1rem',  // 16px
    full: '9999px',
  },

  shadows: {
    subtle: '0 1px 3px 0 rgb(0 0 0 / 0.05), 0 1px 2px -1px rgb(0 0 0 / 0.05)',
    card: '0 4px 6px -1px rgb(0 0 0 / 0.05), 0 2px 4px -2px rgb(0 0 0 / 0.05)',
    elevated: '0 10px 15px -3px rgb(0 0 0 / 0.08), 0 4px 6px -4px rgb(0 0 0 / 0.04)',
    hover: '0 12px 20px -3px rgb(0 0 0 / 0.1), 0 4px 6px -2px rgb(0 0 0 / 0.05)',
  },

  motion: {
    durations: {
      instant: '0ms',
      fast: '120ms',
      normal: '200ms',
      smooth: '320ms',
      slow: '500ms',
    },
    easings: {
      standard: 'cubic-bezier(0.16, 1, 0.3, 1)', // Smooth easeOutCubic/Quart
      anticipate: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      gentle: 'cubic-bezier(0.25, 1, 0.5, 1)',
    },
  },
} as const;

/**
 * Calculates relative luminance for an sRGB hex code per WCAG 2.1 specs.
 */
export function getRelativeLuminance(hex: string): number {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;

  const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

  const R = toLinear(r);
  const G = toLinear(g);
  const B = toLinear(b);

  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/**
 * Calculates contrast ratio between two hex colors per WCAG 2.1 specs.
 */
export function getContrastRatio(hex1: string, hex2: string): number {
  const L1 = getRelativeLuminance(hex1);
  const L2 = getRelativeLuminance(hex2);

  const lighter = Math.max(L1, L2);
  const darker = Math.min(L1, L2);

  const ratio = (lighter + 0.05) / (darker + 0.05);
  return Number(ratio.toFixed(2));
}

export const tokens = designTokens;
