import MarkdownIt from 'markdown-it'
import matter from 'gray-matter'
import { getHighlighter } from 'shiki-es'
import anchor from 'markdown-it-anchor'
import attrs from 'markdown-it-attrs'
import emoji from 'markdown-it-emoji'
import type { Plugin as VitePlugin } from 'vite'
import chokidar from 'chokidar'
import fs from 'fs-extra'
import path from 'pathe'
import { paramCase } from 'change-case'
import pc from 'picocolors'
import type { ServerMarkdownFile } from '@histoire/shared'
import { slugify } from './util/slugify.js'
import type { Context } from './context.js'
import { addStory, notifyStoryChange, removeStory } from './stories.js'

const onMarkdownListChangeHandlers: (() => unknown)[] = []

export function onMarkdownListChange (handler: () => unknown) {
  onMarkdownListChangeHandlers.push(handler)
}

function notifyMarkdownListChange () {
  for (const handler of onMarkdownListChangeHandlers) {
    handler()
  }
}

export async function createMarkdownRenderer (ctx: Context) {
  const highlighter = await getHighlighter({
    theme: 'github-dark',
  })

  const md = new MarkdownIt({
    highlight: (code, lang) => `<div class="htw-relative htw-not-prose __histoire-code"><div class="htw-absolute htw-top-0 htw-right-0 htw-text-xs htw-text-white/40">${lang}</div>${highlighter.codeToHtml(code, {
      lang,
    })}</div>`,
    linkify: true,
    html: true,
    breaks: true,
  })

  md.use(anchor, {
    slugify,
    permalink: anchor.permalink.ariaHidden({}),
  })
    .use(attrs)
    .use(emoji)

  // External links
  {
    const defaultRender = md.renderer.rules.link_open || function (tokens, idx, options, env, self) {
      return self.renderToken(tokens, idx, options)
    }

    md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
      const token = tokens[idx]
      const hrefIndex = token.attrIndex('href')
      const classIndex = token.attrIndex('class')

      if (hrefIndex >= 0) {
        const href = token.attrs[hrefIndex][1]
        if (href.startsWith('.')) {
          const queryIndex = href.indexOf('?')
          const pathname = queryIndex >= 0 ? href.slice(0, queryIndex) : href
          const query = queryIndex >= 0 ? href.slice(queryIndex) : ''

          // File lookup
          const file = path.resolve(path.dirname(env.file), pathname)
          const storyFile = ctx.storyFiles.find(f => f.path === file)
          const mdFile = ctx.markdownFiles.find(f => f.absolutePath === file)
          if (!storyFile && !mdFile?.storyFile) {
            throw new Error(pc.red(`[md] Cannot find story file: ${pathname} from ${env.file}`))
          }

          // Add attributes
          const newHref = `${ctx.resolvedViteConfig.base}story/${encodeURIComponent(storyFile?.id ?? mdFile.storyFile.id)}${query}`
          token.attrSet('href', newHref)
          token.attrSet('data-route', 'true')
        } else if (!href.startsWith('/') && !href.startsWith('#') && (classIndex < 0 || !token.attrs[classIndex][1].includes('header-anchor'))) {
          // Add target="_blank" to external links
          const aIndex = token.attrIndex('target')

          if (aIndex < 0) {
            token.attrPush(['target', '_blank']) // add new attribute
          } else {
            token.attrs[aIndex][1] = '_blank' // replace value of existing attr
          }
        }
      }

      // pass token to default renderer.
      return defaultRender(tokens, idx, options, env, self)
    }
  }

  return md
}

async function createMarkdownRendererWithPlugins (ctx: Context) {
  let md = await createMarkdownRenderer(ctx)
  if (ctx.config.markdown) {
    const result = await ctx.config.markdown(md)
    if (result) {
      md = result
    }
  }
  return md
}

export async function createMarkdownPlugins (ctx: Context) {
  const plugins: VitePlugin[] = []
  const md = await createMarkdownRendererWithPlugins(ctx)

  // @TODO extract
  plugins.push({
    name: 'histoire-vue-docs-block',
    transform (code, id) {
      if (!id.includes('?vue&type=docs')) return
      if (!id.includes('lang.md')) return
      const file = id.substring(0, id.indexOf('?vue'))
      const html = md.render(code, {
        file,
      })
      return `export default Comp => {
        Comp.doc = ${JSON.stringify(html)}
      }`
    },
  })

  return plugins
}

export async function createMarkdownFilesWatcher (ctx: Context) {
  const md = await createMarkdownRendererWithPlugins(ctx)

  const watcher = chokidar.watch(['**/*.story.md'], {
    cwd: ctx.root,
    ignored: ctx.config.storyIgnored,
  })

  async function addFile (relativePath: string) {
    const absolutePath = path.resolve(ctx.root, relativePath)
    const dirFiles = await fs.readdir(path.dirname(absolutePath))
    const truncatedName = path.basename(absolutePath, '.md')
    const isRelatedToStory = dirFiles.some((file) => !file.endsWith('.md') && file.startsWith(truncatedName))

    const { data: frontmatter, content } = matter(await fs.readFile(absolutePath, 'utf8'))
    const html = md.render(content, {
      file: absolutePath,
    })

    const file: ServerMarkdownFile = {
      id: paramCase(relativePath.toLowerCase()),
      relativePath,
      absolutePath,
      isRelatedToStory,
      frontmatter,
      html,
    }
    ctx.markdownFiles.push(file)

    if (!isRelatedToStory) {
      const storyRelativePath = relativePath.replace(/\.md$/, '.js')
      const storyFile = addStory(storyRelativePath, `export default ${JSON.stringify({
        id: frontmatter.id,
        title: frontmatter.title,
        icon: frontmatter.icon ?? 'carbon:document-blank',
        iconColor: frontmatter.iconColor,
        group: frontmatter.group,
        docsOnly: true,
        variants: [],
      })}`)
      file.storyFile = storyFile
      storyFile.markdownFile = file
      notifyStoryChange(storyFile)
    } else {
      const searchPath = path.join(path.dirname(relativePath), truncatedName)
      const storyFile = ctx.storyFiles.find(f => f.relativePath.startsWith(searchPath))
      if (storyFile) {
        file.storyFile = storyFile
        storyFile.markdownFile = file
        notifyStoryChange(storyFile)
      }
    }

    notifyMarkdownListChange()

    return file
  }

  function removeFile (relativePath: string) {
    const index = ctx.markdownFiles.findIndex((file) => file.relativePath === relativePath)
    if (index !== -1) {
      const file = ctx.markdownFiles[index]
      if (!file.isRelatedToStory) {
        removeStory(file.storyFile.relativePath)
        notifyStoryChange()
      }
      ctx.markdownFiles.splice(index, 1)
      notifyMarkdownListChange()
    }
  }

  async function stop () {
    await watcher.close()
  }

  watcher
    .on('add', async (relativePath) => {
      await addFile(relativePath)
    })
    .on('unlink', (relativePath) => {
      removeFile(relativePath)
    })

  await new Promise(resolve => {
    watcher.once('ready', resolve)
  })

  return {
    stop,
  }
}

export type MarkdownFilesWatcher = ReturnType<typeof createMarkdownFilesWatcher>
