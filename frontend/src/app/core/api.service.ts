import { HttpClient, HttpEvent, HttpEventType } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { Observable } from "rxjs";
import type {
  AuthMe,
  BlobReadRequest,
  CatalogUploadResponse,
  CompareRequest,
  CompareResultResponse,
  ConfigInfo,
  ExcelSheetsResponse,
  FileMetaView,
  MappingView,
  WriteToBlobResponse,
} from "../shared/models/dto";

export interface UploadProgress {
  percent: number;
}

/** Thin HttpClient wrapper -- one method per backend route, mirroring the
 * original React app's api.ts. Download endpoints (report.xlsx, annotated
 * files, the catalog template) are exposed as URL builders rather than
 * fetch calls, same as the original: they're meant to be used as <a href>
 * targets so the browser handles Content-Disposition itself. */
@Injectable({ providedIn: "root" })
export class ApiService {
  constructor(private readonly http: HttpClient) {}

  authMe(): Observable<AuthMe> {
    return this.http.get<AuthMe>("/api/auth/me");
  }

  config(): Observable<ConfigInfo> {
    return this.http.get<ConfigInfo>("/api/config");
  }

  uploadCatalog(file: File): Observable<CatalogUploadResponse> {
    const form = new FormData();
    form.append("file", file);
    return this.http.post<CatalogUploadResponse>("/api/catalog/upload", form);
  }

  getMapping(catalogId: string, datasetId: string): Observable<MappingView> {
    return this.http.get<MappingView>(
      `/api/catalog/${encodeURIComponent(catalogId)}/datasets/${encodeURIComponent(datasetId)}/mapping`
    );
  }

  catalogTemplateUrl(): string {
    return "/api/catalog/template";
  }

  /** Multipart upload with progress events, for the file-input component's
   * progress bar -- Angular's equivalent of the original's raw-XHR
   * upload.onprogress handling. */
  uploadFile(
    file: File,
    opts: { sheetName?: string; hasHeader: boolean; delimiter?: string }
  ): Observable<HttpEvent<FileMetaView>> {
    const form = new FormData();
    form.append("file", file);
    if (opts.sheetName) form.append("sheet_name", opts.sheetName);
    form.append("has_header", String(opts.hasHeader));
    if (opts.delimiter) form.append("delimiter", opts.delimiter);
    return this.http.post<FileMetaView>("/api/files/upload", form, {
      reportProgress: true,
      observe: "events",
    });
  }

  listSheets(file: File): Observable<ExcelSheetsResponse> {
    const form = new FormData();
    form.append("file", file);
    return this.http.post<ExcelSheetsResponse>("/api/files/list-sheets", form);
  }

  readBlob(req: BlobReadRequest): Observable<FileMetaView> {
    return this.http.post<FileMetaView>("/api/files/from-blob", req);
  }

  blobSheets(url: string): Observable<ExcelSheetsResponse> {
    return this.http.post<ExcelSheetsResponse>("/api/files/blob-sheets", { url });
  }

  runCompare(req: CompareRequest): Observable<CompareResultResponse> {
    return this.http.post<CompareResultResponse>("/api/compare/run", req);
  }

  reportXlsxUrl(runId: string): string {
    return `/api/compare/${encodeURIComponent(runId)}/report.xlsx`;
  }

  annotatedUrl(runId: string, side: "source" | "target"): string {
    return `/api/compare/${encodeURIComponent(runId)}/annotated/${side}`;
  }

  writeToBlob(runId: string): Observable<WriteToBlobResponse> {
    return this.http.post<WriteToBlobResponse>(`/api/compare/${encodeURIComponent(runId)}/write-to-blob`, {});
  }
}

/** Extracts a 0-100 upload percentage from an HttpEvent stream, or null
 * for events that aren't upload-progress. */
export function uploadPercent(event: HttpEvent<unknown>): number | null {
  if (event.type === HttpEventType.UploadProgress && event.total) {
    return Math.round((100 * event.loaded) / event.total);
  }
  return null;
}
