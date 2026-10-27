// The screens built on the shell (D4 Task 6, D5 Task 5) register themselves in SCREEN_MOUNTS here. app.js imports
// this module once; a screen not in the map shows the "Coming in the next update" panel.
import { mountActivity } from './activity.js';
import { mountAudit } from './audit.js';
import { mountAutomations } from './automations.js';
import { mountMeetings } from './meetings.js';
import { SCREEN_MOUNTS } from './registry.js';
import { mountSettings } from './settings.js';
import { mountTasks } from './tasks.js';
import { mountTracker } from './tracker.js';
import { mountUsage } from './usage.js';

SCREEN_MOUNTS.set('tasks', mountTasks);
SCREEN_MOUNTS.set('meetings', mountMeetings);
SCREEN_MOUNTS.set('activity', mountActivity);
SCREEN_MOUNTS.set('tracker', mountTracker);
SCREEN_MOUNTS.set('usage', mountUsage);
SCREEN_MOUNTS.set('automations', mountAutomations);
SCREEN_MOUNTS.set('audit', mountAudit);
SCREEN_MOUNTS.set('settings', mountSettings);
