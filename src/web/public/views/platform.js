// The platform screens (SaaS S5) register themselves in SCREEN_MOUNTS here: Invite a customer, Getting started (the
// customer's onboarding checklist), and Customers. app.js imports this module once (see the hookups doc); their styles
// are platform.css.
import { mountInvite } from './invite.js';
import { mountOnboarding } from './onboarding.js';
import { SCREEN_MOUNTS } from './registry.js';

if (!document.querySelector('link[data-platform-css]')) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/dashboard/static/platform.css';
  link.dataset.platformCss = '';
  document.head.append(link);
}

SCREEN_MOUNTS.set('invite', mountInvite);
SCREEN_MOUNTS.set('onboarding', mountOnboarding);
