import type { ImageSourcePropType } from 'react-native';

/** Local demo photography — sources recorded in docs/ASSET_ATTRIBUTION.md. */
export const demoImages: Record<string, ImageSourcePropType> = {
  art: require('@/assets/images/demo/art.jpg'),
  books: require('@/assets/images/demo/books.jpg'),
  boxing: require('@/assets/images/demo/boxing.jpg'),
  coding: require('@/assets/images/demo/coding.jpg'),
  fitnessWoman: require('@/assets/images/demo/fitness-woman.jpg'),
  football: require('@/assets/images/demo/football.jpg'),
  gym: require('@/assets/images/demo/gym.jpg'),
  karate: require('@/assets/images/demo/karate.jpg'),
  library: require('@/assets/images/demo/library.jpg'),
  poolLanes: require('@/assets/images/demo/pool-lanes.jpg'),
  quran: require('@/assets/images/demo/quran.jpg'),
  robotics: require('@/assets/images/demo/robotics.jpg'),
  swimRace: require('@/assets/images/demo/swim-race.jpg'),
  tennis: require('@/assets/images/demo/tennis.jpg'),
  wellness: require('@/assets/images/demo/wellness.jpg'),
  yogaCalm: require('@/assets/images/demo/yoga-calm.jpg'),
  yogaPose: require('@/assets/images/demo/yoga-pose.jpg'),
};

export function demoImage(key: string): ImageSourcePropType | undefined {
  return demoImages[key];
}
