import { MapScreen } from '@/features/map/map-screen';

/**
 * HMA-016 — schematic map. Root-level push, so the floating dock (owned by
 * the tab navigator) is hidden structurally rather than by a per-screen hack
 * (docs/16 §6).
 */
export default function Map() {
  return <MapScreen />;
}
