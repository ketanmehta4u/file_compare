import { Injectable } from "@angular/core";
import { BehaviorSubject } from "rxjs";
import { ApiService } from "./api.service";
import type { ConfigInfo } from "../shared/models/dto";

/** Fetches /api/config once at bootstrap and exposes it as observable
 * state -- capability flags (blob read/write, always false in this port)
 * and the effective upload size cap the file-input component pre-checks
 * against before uploading. */
@Injectable({ providedIn: "root" })
export class ConfigService {
  private readonly subject = new BehaviorSubject<ConfigInfo | null>(null);
  readonly config$ = this.subject.asObservable();

  constructor(private readonly api: ApiService) {}

  load(): void {
    this.api.config().subscribe({
      next: (cfg) => this.subject.next(cfg),
      error: () => this.subject.next(null),
    });
  }

  get value(): ConfigInfo | null {
    return this.subject.value;
  }
}
