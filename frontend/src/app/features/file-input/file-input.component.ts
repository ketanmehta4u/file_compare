import { Component, EventEmitter, Input, Output } from "@angular/core";
import { HttpEventType } from "@angular/common/http";
import { ApiService, uploadPercent } from "../../core/api.service";
import type { FileMetaView } from "../../shared/models/dto";

function extensionOf(name: string): string {
  const parts = name.toLowerCase().split(".");
  return parts.length > 1 ? parts[parts.length - 1] : "";
}

function isExcelName(name: string): boolean {
  return extensionOf(name) === "xlsx";
}

/** Extensions this build can actually parse. Legacy `.xls` (OLE2) is
 * deliberately out of scope -- the backend detects it by magic bytes and
 * rejects it, so it is caught here too rather than after a full upload
 * round-trip. */
const ACCEPTED_EXTENSIONS = ["csv", "xlsx"];

/** A file size for people: "845 B", "12.4 KB", "3.2 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Port of the original's FileInput.tsx, reused for both Source and
 * Target. Blob-URL mode is dropped entirely in this port -- blob storage
 * is a stubbed-off, always-400 feature here (see backend/src/api/routes/
 * files.ts), so /api/config always reports blob_read_enabled=false and
 * the original's blob-mode toggle would never actually show. Local
 * upload only.
 */
@Component({
  selector: "app-file-input",
  templateUrl: "./file-input.component.html",
})
export class FileInputComponent {
  @Input() label: "Source" | "Target" = "Source";

  /** Distinct per instance, so the two copies of this component do not
   * share an id and mislabel each other. */
  get inputId(): string {
    return `file-input-${this.label.toLowerCase()}`;
  }
  @Input() maxUploadBytes: number | null = null;
  @Output() loaded = new EventEmitter<FileMetaView | null>();

  hasHeader = true;
  delimiter = "";
  pickedFile: File | null = null;
  sheets: string[] = [];
  chosenSheet = "";
  sizeError = "";
  loadError = "";
  progress: number | null = null;
  meta: FileMetaView | null = null;
  sheetsLoading = false;
  /** A file is being dragged over the drop zone. */
  dragging = false;

  readonly formatBytes = formatBytes;

  constructor(private readonly api: ApiService) {}

  onFileChosen(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) this.chooseFile(file);
  }

  /** Must cancel the default, or the browser refuses the drop (and would
   * open the file in the tab instead). */
  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragging = true;
  }

  onDragLeave(): void {
    this.dragging = false;
  }

  /** A dropped file goes through exactly the same checks as a picked one. */
  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging = false;
    const file = event.dataTransfer?.files?.[0];
    if (file) this.chooseFile(file);
  }

  /** Validates a picked or dropped file, and lists its sheets if it is a
   * workbook. Nothing is uploaded until load(). */
  chooseFile(file: File): void {
    this.sizeError = "";
    this.loadError = "";
    this.sheets = [];
    this.chosenSheet = "";
    this.meta = null;
    this.loaded.emit(null);

    const ext = extensionOf(file.name);
    if (!ACCEPTED_EXTENSIONS.includes(ext)) {
      this.sizeError =
        ext === "xls"
          ? `${file.name} is a legacy .xls workbook, which this application cannot read — re-save it as .xlsx or .csv and try again.`
          : `${file.name} is not a supported file type — upload a .csv or .xlsx file.`;
      this.pickedFile = null;
      return;
    }

    if (this.maxUploadBytes && file.size > this.maxUploadBytes) {
      this.sizeError = `${file.name} is ${(file.size / (1024 * 1024)).toFixed(1)} MB, over the ${(this.maxUploadBytes / (1024 * 1024)).toFixed(0)} MB limit.`;
      this.pickedFile = null;
      return;
    }

    this.pickedFile = file;
    if (isExcelName(file.name)) {
      this.sheetsLoading = true;
      this.api.listSheets(file).subscribe({
        next: (res) => {
          this.sheetsLoading = false;
          this.sheets = res.sheets;
          this.chosenSheet = res.sheets[0] ?? "";
        },
        error: (err) => {
          this.sheetsLoading = false;
          this.loadError = err?.error?.detail ?? "Failed to list sheets.";
        },
      });
    }
  }

  get isExcel(): boolean {
    return !!this.pickedFile && isExcelName(this.pickedFile.name);
  }

  load(): void {
    if (!this.pickedFile) return;
    this.progress = 0;
    this.loadError = "";
    this.api
      .uploadFile(this.pickedFile, {
        sheetName: this.chosenSheet || undefined,
        hasHeader: this.hasHeader,
        delimiter: this.delimiter || undefined,
      })
      .subscribe({
        next: (event) => {
          const pct = uploadPercent(event);
          if (pct !== null) this.progress = pct;
          if (event.type === HttpEventType.Response && event.body) {
            this.progress = null;
            this.meta = event.body;
            this.loaded.emit(event.body);
          }
        },
        error: (err) => {
          this.progress = null;
          this.loadError = err?.error?.detail ?? "Upload failed.";
        },
      });
  }
}
