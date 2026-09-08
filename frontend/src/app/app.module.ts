/**
 * The single NgModule for this app.
 *
 * There is no router: the whole flow -- upload, map, compare, read the
 * result -- is one page, so the six feature components are composed
 * directly by AppComponent rather than routed to. The APP_INITIALIZER
 * applies the branding from theme.ts (CSS custom properties, page title,
 * favicon) before the first render, so the page never flashes unthemed.
 */
import { APP_INITIALIZER, NgModule } from "@angular/core";
import { BrowserModule } from "@angular/platform-browser";
import { HttpClientModule } from "@angular/common/http";
import { FormsModule, ReactiveFormsModule } from "@angular/forms";

import { AppComponent } from "./app.component";
import { CatalogPickerComponent } from "./features/catalog-picker/catalog-picker.component";
import { FileInputComponent } from "./features/file-input/file-input.component";
import { SettingsPanelComponent } from "./features/settings-panel/settings-panel.component";
import { ResultsComponent } from "./features/results/results.component";
import { HowToUseComponent } from "./features/how-to-use/how-to-use.component";
import { ThemeService } from "./core/theme.service";

/** APP_INITIALIZER factory: Angular waits for this before bootstrapping
 * the root component. */
export function initTheme(theme: ThemeService): () => void {
  return () => theme.apply();
}

@NgModule({
  declarations: [
    AppComponent,
    CatalogPickerComponent,
    FileInputComponent,
    SettingsPanelComponent,
    ResultsComponent,
    HowToUseComponent,
  ],
  imports: [BrowserModule, HttpClientModule, FormsModule, ReactiveFormsModule],
  providers: [{ provide: APP_INITIALIZER, useFactory: initTheme, deps: [ThemeService], multi: true }],
  bootstrap: [AppComponent],
})
export class AppModule {}
