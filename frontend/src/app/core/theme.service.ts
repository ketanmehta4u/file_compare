import { Injectable } from "@angular/core";
import { CSS_VAR_MAP, faviconMimeType, theme, type Theme } from "../theme";

/** Applies the active Theme to the document: CSS custom properties, page
 * title, and favicon. Called once at bootstrap via APP_INITIALIZER (see
 * app.module.ts) -- port of the original's applyTheme(). */
@Injectable({ providedIn: "root" })
export class ThemeService {
  readonly theme: Theme = theme;

  apply(t: Theme = theme): void {
    const root = document.documentElement;
    for (const [cssVar, key] of Object.entries(CSS_VAR_MAP)) {
      root.style.setProperty(cssVar, t.colors[key]);
    }

    document.title = `${t.productName} — ${t.orgName}`;

    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.type = faviconMimeType(t.faviconSrc);
    link.href = t.faviconSrc;
  }
}
