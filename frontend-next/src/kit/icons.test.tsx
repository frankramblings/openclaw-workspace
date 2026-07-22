// Tests for Icon and Fortress components
import { describe, it, expect, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { Icon, Fortress } from './icons'

describe('Icon component', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('renders chat icon with default size and attributes', () => {
    const { container } = render(<Icon name="chat" />)

    const svgs = container.querySelectorAll('svg')
    expect(svgs).toHaveLength(1)

    const svg = svgs[0]
    expect(svg.getAttribute('width')).toBe('18')
    expect(svg.getAttribute('height')).toBe('18')
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(svg.getAttribute('stroke')).toBe('currentColor')
    expect(svg.getAttribute('fill')).toBe('none')
    expect(svg.getAttribute('stroke-width')).toBe('1.7')
    expect(svg.innerHTML).toContain('M21 11.5a8.38')
  })

  it('respects size prop override', () => {
    const { container } = render(<Icon name="chat" size={24} />)
    const svg = container.querySelector('svg')

    expect(svg?.getAttribute('width')).toBe('24')
    expect(svg?.getAttribute('height')).toBe('24')
  })

  it('honors per-icon defaults', () => {
    // check: width 26, stroke 'var(--teal)', stroke-width '2.2'
    const { container: checkContainer } = render(<Icon name="check" />)
    const checkSvg = checkContainer.querySelector('svg')
    expect(checkSvg?.getAttribute('width')).toBe('26')
    expect(checkSvg?.getAttribute('stroke')).toBe('var(--teal)')
    expect(checkSvg?.getAttribute('stroke-width')).toBe('2.2')

    // search: width 14, stroke 'var(--faint)', stroke-width '2'
    const { container: searchContainer } = render(<Icon name="search" />)
    const searchSvg = searchContainer.querySelector('svg')
    expect(searchSvg?.getAttribute('width')).toBe('14')
    expect(searchSvg?.getAttribute('stroke')).toBe('var(--faint)')
    expect(searchSvg?.getAttribute('stroke-width')).toBe('2')

    // dots: fill 'currentColor'
    const { container: dotsContainer } = render(<Icon name="dots" />)
    const dotsSvg = dotsContainer.querySelector('svg')
    expect(dotsSvg?.getAttribute('fill')).toBe('currentColor')

    // send: width 17, stroke-width '2.2'
    const { container: sendContainer } = render(<Icon name="send" />)
    const sendSvg = sendContainer.querySelector('svg')
    expect(sendSvg?.getAttribute('width')).toBe('17')
    expect(sendSvg?.getAttribute('stroke-width')).toBe('2.2')
  })

  it('play icon has fill and no stroke attribute', () => {
    const { container } = render(<Icon name="play" />)
    const svg = container.querySelector('svg')

    expect(svg?.getAttribute('fill')).toBe('currentColor')
    expect(svg?.getAttribute('stroke')).toBeNull()
    expect(svg?.innerHTML).toContain('M8 5v14l11-7z')
  })

  it('passes through className prop', () => {
    const { container } = render(<Icon name="x" className="foo" />)
    const svg = container.querySelector('svg')

    expect(svg?.classList.contains('foo')).toBe(true)
  })

  it('renders all icon names', () => {
    const iconNames = [
      'chat', 'inbox', 'email', 'calendar', 'research', 'library', 'notes', 'settings',
      'chevLeft', 'chevRight', 'chevDown', 'chevDownSm', 'search', 'plus', 'send', 'x',
      'copy', 'download', 'branch', 'edit', 'star', 'dots', 'pencil', 'archive', 'trash',
      'check', 'reply', 'file', 'folder', 'terminal', 'split', 'panelHide', 'panelShow',
      'play', 'code', 'refresh', 'clock'
    ] as const

    iconNames.forEach(name => {
      const { container } = render(<Icon name={name} />)
      const svg = container.querySelector('svg')
      expect((svg?.innerHTML ?? '').length).toBeGreaterThan(0)
    })
  })
})

describe('Fortress component', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('renders with correct defaults and attributes', () => {
    const { container } = render(<Fortress />)
    const svg = container.querySelector('svg')

    expect(svg?.getAttribute('width')).toBe('16')
    expect(svg?.getAttribute('height')).toBe('16')
    expect(svg?.getAttribute('viewBox')).toBe('0 0 48 48')
    expect(svg?.classList.contains('fl-svg')).toBe(true)
    expect(svg?.getAttribute('role')).toBe('img')
    expect(svg?.getAttribute('aria-label')).toBe('Loading')
    expect(svg?.innerHTML).toContain('fl-crystal fl-c1')
    expect(svg?.innerHTML).toContain('fl-shard fl-s3')
  })
})
