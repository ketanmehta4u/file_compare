import { HttpClient, HttpEvent, HttpEventType } from "@angular/common/http";
import { Injectable } from "@angular/core";
import { Observable } from "rxjs";
import type {
  CompareJobCancelled,
  CompareJobStarted,
  CompareJobView,
  CatalogUploadResponse,
  CompareRequest,
  CompareResultResponse,
  ConfigInfo,
  ExcelSheetsResponse,
  FileMetaView,
  MappingView,
} from "../shared/models/dto";

export interface UploadProgress {
  percent: number;
}

/** Thin HttpClient wrapper -- one method per backend route this app
 * actually uses. The blob-storage routes are not among them: the server
 * ships them hard-disabled, so a client for them would be dead weight.
 * Nor is /api/auth/me: there is no login, and the identity it reports is
 * recorded server-side in the audit report rather than shown in the page.
 *
 * Download endpoints (report.xlsx, the catalogue template) are exposed as
 * URL builders rather than fetch calls: they are meant to be used as
 * <a href> targets so the browser handles Content-Disposition itself. */
@Injectable({ providedIn: "root" })
export class ApiService {
  constructor(private readonly http: HttpClient) {}

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

  /** Starts a comparison in the background; returns as soon as the server
   * has queued it, rather than holding the connection open for the whole
   * run. Poll compareJob() for progress.
   *
   * The server also offers a synchronous POST /api/compare/run that
   * returns the finished result in one response. This app does not use it
   * -- a large comparison takes minutes, which is longer than intermediate
   * proxies will hold a connection open, and it cannot report progress. */
  startCompareJob(req: CompareRequest): Observable<CompareJobStarted> {
    return this.http.post<CompareJobStarted>("/api/compare/jobs", req);
  }

  compareJob(jobId: string): Observable<CompareJobView> {
    return this.http.get<CompareJobView>(`/api/compare/jobs/${encodeURIComponent(jobId)}`);
  }

  cancelCompareJob(jobId: string): Observable<CompareJobCancelled> {
    return this.http.delete<CompareJobCancelled>(`/api/compare/jobs/${encodeURIComponent(jobId)}`);
  }

  reportXlsxUrl(runId: string): string {
    return `/api/compare/${encodeURIComponent(runId)}/report.xlsx`;
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
