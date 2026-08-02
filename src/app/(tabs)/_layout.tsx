import { FloatingDock, type DockDestinationId } from '@/components/domain/floating-dock';
import { Tabs } from 'expo-router';

/** Maps the tab navigator's route names to dock destination ids. */
const routeToDock: Record<string, DockDestinationId> = {
  index: 'home',
  discover: 'discover',
};

interface TabBarState {
  index: number;
  routes: { key: string; name: string }[];
}

interface TabBarNavigation {
  emit: (event: { type: 'tabPress'; target: string; canPreventDefault: true }) => {
    defaultPrevented: boolean;
  };
  navigate: (name: string) => void;
}

/**
 * The approved FloatingDock as the Tabs custom tab bar. Home and Discover are
 * real destinations; Bookings, Saved, and Profile stay inert with press
 * feedback only, and the active pill never moves to them (docs/09 §17.2,
 * docs/11 §8). The dock overlays content (absolute position), so scenes keep
 * full height and screens keep their own bottom clearance.
 */
function DockTabBar({ state, navigation }: { state: TabBarState; navigation: TabBarNavigation }) {
  const activeRoute = state.routes[state.index];
  const activeId = routeToDock[activeRoute.name] ?? 'home';

  const onPressDestination = (id: DockDestinationId) => {
    const route = state.routes.find((candidate) => routeToDock[candidate.name] === id);
    if (route === undefined) return; // Bookings / Saved / Profile: inert
    const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
    if (activeRoute.key !== route.key && !event.defaultPrevented) {
      navigation.navigate(route.name);
    }
  };

  return <FloatingDock activeId={activeId} onPressDestination={onPressDestination} />;
}

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <DockTabBar state={props.state} navigation={props.navigation} />}
      screenOptions={{ headerShown: false }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="discover" />
    </Tabs>
  );
}
