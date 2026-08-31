// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import SidebarThreadControls from './SidebarThreadControls.vue'

describe('SidebarThreadControls', () => {
  it('offers a one-shot manual refresh without auto-refresh state', async () => {
    const wrapper = mount(SidebarThreadControls, {
      props: {
        isSidebarCollapsed: false,
        refreshButtonLabel: 'Refresh',
        showNewThreadButton: true,
      },
    })

    const refreshButton = wrapper.get('button[aria-label="Refresh"]')
    expect(refreshButton.attributes('aria-pressed')).toBeUndefined()
    await refreshButton.trigger('click')

    expect(wrapper.emitted('refresh')).toHaveLength(1)
    expect(wrapper.emitted('toggle-auto-refresh')).toBeUndefined()
  })
})
