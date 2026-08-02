import { HomeScreen } from '@/features/home/home-screen';

/**
 * Milestone 1: Home is the only routed screen. Other dock destinations are
 * inert by design (docs/09 §17.2); their routes arrive with their milestones.
 */
export default function Index() {
  return <HomeScreen />;
}
