/**
 * theme.ts — single source of truth for the application's branding.
 * ================================================================
 * Port of the original React app's theme.ts, unchanged in spirit: every
 * brand value lives here, components/CSS read from it rather than
 * hardcoding, so a re-brand is a one-file edit. ThemeService.apply()
 * plays the role of the original's applyTheme(), called once at
 * bootstrap via APP_INITIALIZER.
 */

export interface FooterLink {
  label: string;
  href: string;
}

/** The palette, written into CSS custom properties at startup so the
 * stylesheet and the components read the same values. */
export interface ThemeColors {
  bg: string;
  panel: string;
  border: string;
  text: string;
  muted: string;
  navy: string;
  navyStrong: string;
  bright: string;
  accentBg: string;
  good: string;
  warn: string;
  bad: string;
  code: string;
}

/** Everything that identifies the organisation and the product: names,
 * logos, the disclaimer, the palette and the footer links. */
export interface Theme {
  orgName: string;
  orgLegalName: string;
  productName: string;
  ribbonTagline: string;
  /** The disclaimer shown at the bottom of every page. */
  footerNote: string;
  logoSrc: string;
  /** The logo for the dark blue strip: the same mark with white lettering,
   * since the standard navy lettering disappears against navy. */
  logoOnDarkSrc: string;
  logoAlt: string;
  faviconSrc: string;
  colors: ThemeColors;
  footerLinksTitle: string;
  footerLinks: FooterLink[];
}

/** The active branding. Editing this file re-brands the whole app. */
export const theme: Theme = {
  orgName: "The World Bank",
  orgLegalName: "The World Bank Group",
  productName: "File Reconciliation",
  ribbonTagline: "Product Control",
  footerNote:
    "Compare and reconcile two financial-reporting files. Outputs an audit-ready " +
    "report. This tool assists reconciliation but does not replace independent " +
    "verification or sign-off.",

  logoSrc: "assets/wbg-logo.svg",
  logoOnDarkSrc: "assets/wbg-logo-white.svg",
  logoAlt: "World Bank Group",
  faviconSrc: "favicon.ico",

  colors: {
    bg: "#f4f6f9",
    panel: "#ffffff",
    border: "#d9dee5",
    text: "#1f2328",
    muted: "#57606a",
    navy: "#002244",
    navyStrong: "#00376b",
    bright: "#009fda",
    accentBg: "#e6f4fb",
    good: "#1a7f37",
    warn: "#9a6700",
    bad: "#cf222e",
    code: "#f0f3f7",
  },

  footerLinksTitle: "World Bank Group",
  footerLinks: [
    { label: "Home", href: "https://www.worldbank.org" },
    { label: "Who We Are", href: "https://www.worldbank.org/en/who-we-are" },
    { label: "Open Data", href: "https://data.worldbank.org" },
    { label: "Projects & Operations", href: "https://projects.worldbank.org" },
  ],
};

/** CSS custom property -> palette entry, applied by ThemeService. Several
 * properties deliberately map to the same colour. */
export const CSS_VAR_MAP: Record<string, keyof ThemeColors> = {
  "--bg": "bg",
  "--panel": "panel",
  "--border": "border",
  "--text": "text",
  "--muted": "muted",
  "--wb-navy": "navy",
  "--wb-navy-strong": "navyStrong",
  "--wb-blue": "bright",
  "--accent": "navy",
  "--accent-bright": "bright",
  "--accent-bg": "accentBg",
  "--good": "good",
  "--warn": "warn",
  "--bad": "bad",
  "--code": "code",
};

/** The MIME type for a favicon path, so the link tag declares it
 * correctly whatever image format the branding uses. */
export function faviconMimeType(src: string): string {
  const ext = src.slice(src.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "svg":
      return "image/svg+xml";
    case "ico":
      return "image/x-icon";
    case "png":
      return "image/png";
    default:
      return "image/x-icon";
  }
}
