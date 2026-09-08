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
