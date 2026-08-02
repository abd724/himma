/**
 * Frontend domain types — docs/08 §9.
 * Enough structure to keep the mock frontend coherent; deliberately not the
 * production data model.
 */

export type ParticipantId = 'everyone' | 'me' | string;

export interface Participant {
  id: ParticipantId;
  /** Customer-facing label, e.g. "Me", "Adam". */
  label: string;
  kind: 'everyone' | 'self' | 'child';
  age?: number;
}

export type AreaId =
  | 'khalifa-city'
  | 'al-raha'
  | 'mbz-city'
  | 'yas-island'
  | 'al-reem'
  | 'saadiyat';

export interface Area {
  id: AreaId;
  label: string;
  /** Areas considered nearby for "Near me" ranking, closest first. */
  nearby: AreaId[];
}

export type CategoryId =
  | 'fitness'
  | 'boxing'
  | 'pilates'
  | 'swimming'
  | 'padel'
  | 'wellness'
  | 'learning'
  | 'kids-teens';

export interface Category {
  id: CategoryId;
  label: string;
  imageKey: string;
}

export interface Provider {
  id: string;
  name: string;
  categories: string[];
  areaId: AreaId;
  rating: number;
  verified: boolean;
}

export type PriceModel =
  | { kind: 'dropIn'; amount: number }
  | { kind: 'monthly'; amount: number }
  | { kind: 'term'; amount: number }
  | { kind: 'camp'; amountPerWeek: number }
  | { kind: 'package'; amount: number; sessions: number }
  | { kind: 'freeTrial' };

export type Audience = 'adults' | 'kids' | 'teens' | 'all';

export interface Eligibility {
  audience: Audience;
  minAge?: number;
  maxAge?: number;
  /** True when the program has ladies-only sessions. */
  ladiesOnly?: boolean;
}

export interface Offer {
  kind: 'freeTrial' | 'paidTrial' | 'discount' | 'promo';
  label: string;
}

export interface Program {
  id: string;
  title: string;
  providerId: string;
  categoryId: CategoryId;
  activityType: string;
  areaId: AreaId;
  imageKey: string;
  /** Customer-facing schedule line, e.g. "Tue & Thu · 5:00 PM". */
  scheduleLabel: string;
  /** Time shown when the program runs on the mock "today", e.g. "7:30 PM". */
  todayTime?: string;
  availableToday: boolean;
  runsOnWeekend: boolean;
  isCamp: boolean;
  price: PriceModel;
  eligibility: Eligibility;
  rating: number;
  offer?: Offer;
}

export interface CreditSummary {
  /** Fictional demo balance in AED. */
  availableCredit: number;
}
