import { createElement as h } from 'react';
import { AddonPanel } from 'storybook/internal/components';
import { addons, types } from 'storybook/manager-api';
import { ADDON_ID, PANEL_ID } from './constants.js';
import { FeedbackPanel } from './Panel.js';

addons.register(ADDON_ID, () => {
  addons.add(PANEL_ID, {
    type: types.PANEL,
    title: 'Feedback',
    match: ({ viewMode }) => viewMode === 'story',
    render: ({ active }) => h(AddonPanel, { active: Boolean(active) }, h(FeedbackPanel, null)),
  });
});
