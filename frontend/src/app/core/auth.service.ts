import { Injectable } from "@angular/core";
import { BehaviorSubject } from "rxjs";
import { ApiService } from "./api.service";

/** Fetches /api/auth/me once at bootstrap -- the identity a fronting
 * reverse proxy already verified (empty string when running
 * unauthenticated, e.g. local dev). */
@Injectable({ providedIn: "root" })
export class AuthService {
  private readonly subject = new BehaviorSubject<string>("");
  readonly user$ = this.subject.asObservable();

  constructor(private readonly api: ApiService) {}

  load(): void {
    this.api.authMe().subscribe({
      next: (r) => this.subject.next(r.user),
      error: () => this.subject.next(""),
    });
  }

  get value(): string {
    return this.subject.value;
  }
}
