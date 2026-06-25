import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-floatbar.js';
import './slicc-cost-overlay.js';
import type { SliccFloatbar } from './slicc-floatbar.js';

const meta: Meta = {
  title: 'Primitives/CostOverlay',
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj;

/** Standalone overlay card (always open) showing typical session data. */
export const Standalone: Story = {
  render: () => {
    const wrapper = document.createElement('div');
    wrapper.style.position = 'relative';
    wrapper.style.display = 'inline-block';
    wrapper.style.marginTop = '16px';
    wrapper.style.marginLeft = '100px';

    const el = document.createElement('slicc-cost-overlay');
    el.models = [
      { model: 'claude-opus-4-6', cost: 3.5, turns: 8, tokens: 1_200_000 },
      { model: 'claude-sonnet-4-6', cost: 0.44, turns: 3, tokens: 85_000 },
      { model: 'claude-haiku-4-5', cost: 0.02, turns: 1, tokens: 4_500 },
    ];
    el.scoops = [
      { name: 'sliccy', model: 'claude-opus-4-6', cost: 2.8, type: 'cone' },
      { name: 'researcher', model: 'claude-sonnet-4-6', cost: 0.94, type: 'scoop' },
      { name: 'code-review', model: 'claude-sonnet-4-6', cost: 0.2, type: 'scoop' },
      { name: 'quick-lookup', model: 'claude-haiku-4-5', cost: 0.02, type: 'scoop' },
    ];
    el.open = true;
    wrapper.appendChild(el);
    return wrapper;
  },
};

/** Floatbar with cost overlay — hover the $ amount to see the overlay. */
export const FloatbarWithOverlay: Story = {
  render: () => {
    const wrapper = document.createElement('div');
    wrapper.style.display = 'flex';
    wrapper.style.justifyContent = 'flex-end';
    wrapper.style.padding = '16px 24px';

    const fb = document.createElement('slicc-floatbar') as SliccFloatbar;
    fb.label = 'npx · live';
    fb.online = true;
    fb.spent = '3.96';
    fb.costModels = [
      { model: 'claude-opus-4-6', cost: 3.5, turns: 8, tokens: 1_200_000 },
      { model: 'claude-sonnet-4-6', cost: 0.44, turns: 3, tokens: 85_000 },
      { model: 'claude-haiku-4-5', cost: 0.02, turns: 1, tokens: 4_500 },
    ];
    fb.costScoops = [
      { name: 'sliccy', model: 'claude-opus-4-6', cost: 2.8, type: 'cone' },
      { name: 'researcher', model: 'claude-sonnet-4-6', cost: 0.94, type: 'scoop' },
      { name: 'code-review', model: 'claude-sonnet-4-6', cost: 0.2, type: 'scoop' },
      { name: 'quick-lookup', model: 'claude-haiku-4-5', cost: 0.02, type: 'scoop' },
    ];
    wrapper.appendChild(fb);
    return wrapper;
  },
};

/** Overlay with only models (no scoops section). */
export const ModelsOnly: Story = {
  render: () => {
    const wrapper = document.createElement('div');
    wrapper.style.position = 'relative';
    wrapper.style.display = 'inline-block';
    wrapper.style.marginTop = '16px';
    wrapper.style.marginLeft = '100px';

    const el = document.createElement('slicc-cost-overlay');
    el.models = [{ model: 'claude-opus-4-6', cost: 1.23, turns: 4, tokens: 450_000 }];
    el.scoops = [];
    el.open = true;
    wrapper.appendChild(el);
    return wrapper;
  },
};

/** Large session with many models and agents. */
export const LargeSession: Story = {
  render: () => {
    const wrapper = document.createElement('div');
    wrapper.style.position = 'relative';
    wrapper.style.display = 'inline-block';
    wrapper.style.marginTop = '16px';
    wrapper.style.marginLeft = '100px';

    const el = document.createElement('slicc-cost-overlay');
    el.models = [
      { model: 'claude-opus-4-6', cost: 12.45, turns: 30, tokens: 4_200_000 },
      { model: 'claude-sonnet-4-6', cost: 3.21, turns: 15, tokens: 1_800_000 },
      { model: 'claude-haiku-4-5', cost: 0.18, turns: 8, tokens: 120_000 },
    ];
    el.scoops = [
      { name: 'sliccy', model: 'claude-opus-4-6', cost: 8.5, type: 'cone' },
      { name: 'architect', model: 'claude-opus-4-6', cost: 3.95, type: 'scoop' },
      { name: 'implementer-1', model: 'claude-sonnet-4-6', cost: 1.8, type: 'scoop' },
      { name: 'implementer-2', model: 'claude-sonnet-4-6', cost: 1.41, type: 'scoop' },
      { name: 'reviewer', model: 'claude-haiku-4-5', cost: 0.18, type: 'scoop' },
    ];
    el.open = true;
    wrapper.appendChild(el);
    return wrapper;
  },
};
