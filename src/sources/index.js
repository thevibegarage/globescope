import { config } from '../config.js';
import tfl from './tfl.js';
import norway from './norway.js';
import hongkong from './hongkong.js';
import nzta from './nzta.js';
import singapore from './singapore.js';
import caltrans from './caltrans.js';
import digitraffic from './digitraffic.js';
import windy from './windy.js';
import { cr511Sources } from './cr511.js';

const ALL = [tfl, caltrans, digitraffic, norway, hongkong, nzta, singapore, ...cr511Sources, windy];

export function activeSources() {
  return ALL.filter((s) => {
    if (config.disabledSources.includes(s.id)) return false;
    if ('enabled' in s && !s.enabled) return false;
    return true;
  });
}

export const allSources = ALL;
