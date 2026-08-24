import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeInventoryCardText, PluginInventoryCardReader, readPluginInventoryCard, readReadmeFallback } from '../../src/host/card.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(): { root: string; packageDir: string; baseUrl: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-inventory-card-'))
  tempDirs.push(root)
  const packageDir = join(root, 'node_modules', '@fixture', 'card')
  mkdirSync(packageDir, { recursive: true })
  return { root, packageDir, baseUrl: pathToFileURL(join(root, 'noop.js')).href }
}

describe('plugin inventory card reader', () => {
  it('reads the standard dsh.inventory card from package.json', () => {
    const { packageDir, baseUrl } = fixture()
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
      name: '@fixture/card',
      dsh: {
        inventory: {
          title: { zh: '插件清单', en: 'Plugin list' },
          description: { zh: '只读展示当前插件列表。', en: 'Read-only plugin list.' },
        },
      },
    }))

    expect(readPluginInventoryCard('@fixture/card', baseUrl)).toEqual({
      title: { zh: '插件清单', en: 'Plugin list' },
      description: { zh: '只读展示当前插件列表。', en: 'Read-only plugin list.' },
    })
  })

  it('falls back to README prose and the package description', () => {
    const { packageDir, baseUrl } = fixture()
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
      name: '@fixture/card',
      description: 'English package summary.',
    }))
    writeFileSync(join(packageDir, 'README.zh.md'), [
      '# @fixture/card',
      '',
      '[English](README.md) | 中文',
      '',
      '中文能力简介。',
    ].join('\n'))

    expect(readPluginInventoryCard('@fixture/card', baseUrl)).toEqual({
      title: null,
      description: { zh: '中文能力简介。', en: 'English package summary.' },
    })
  })

  it('returns an empty card for unresolvable modules', () => {
    expect(readPluginInventoryCard('cordis:builtin', undefined)).toEqual({
      title: null,
      description: null,
    })
    expect(readPluginInventoryCard('@fixture/missing', undefined)).toEqual({
      title: null,
      description: null,
    })
  })

  it('indexes node_modules once and refreshes after drop()', () => {
    const { packageDir, baseUrl } = fixture()
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
      name: '@fixture/card',
      dsh: {
        inventory: {
          title: '初始标题',
          description: '初始简介。',
        },
      },
    }))
    const reader = new PluginInventoryCardReader(baseUrl)
    expect(reader.read('@fixture/card')).toEqual({
      title: { zh: '初始标题', en: '初始标题' },
      description: { zh: '初始简介。', en: '初始简介。' },
    })

    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
      name: '@fixture/card',
      dsh: {
        inventory: {
          title: '新标题',
          description: '新简介。',
        },
      },
    }))
    expect(reader.read('@fixture/card').title?.zh).toBe('初始标题')

    reader.drop('@fixture/card')
    expect(reader.read('@fixture/card')).toEqual({
      title: { zh: '新标题', en: '新标题' },
      description: { zh: '新简介。', en: '新简介。' },
    })
  })

  it('normalizes manifest text and README paragraphs', () => {
    expect(normalizeInventoryCardText('same')).toEqual({ zh: 'same', en: 'same' })
    expect(normalizeInventoryCardText('')).toBeNull()
    expect(normalizeInventoryCardText({ zh: '中文', en: 'English' })).toEqual({ zh: '中文', en: 'English' })
    expect(normalizeInventoryCardText({ zh: '', en: 'English' })).toBeNull()
    expect(normalizeInventoryCardText({ zh: 5, en: 'English' })).toBeNull()
    expect(normalizeInventoryCardText(7)).toBeNull()

    const root = fixture().root
    const readme = join(root, 'README.md')
    writeFileSync(readme, '# Title\n\nEnglish | [中文](README.zh.md)\n\nFirst paragraph is kept.')
    expect(readReadmeFallback(readme)).toBe('First paragraph is kept.')
  })
})
