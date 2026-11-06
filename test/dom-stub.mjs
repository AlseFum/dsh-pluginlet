/**
 * A tiny DOM good enough for the sandbox runtime: elements, text nodes,
 * attributes, inline style, listeners, innerHTML clearing, and child ordering.
 * Used by the runtime tests so they do not need a browser or jsdom.
 */

let sequence = 0

function makeText(data) {
  return {
    id: ++sequence,
    nodeType: 3,
    data: String(data),
    parentNode: null,
    get textContent() { return this.data },
    set textContent(value) { this.data = String(value) },
  }
}

function makeElement(tag) {
  const el = {
    id: ++sequence,
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    childNodes: [],
    style: {},
    attributes: {},
    listeners: {},
    value: '',
    checked: false,
    disabled: false,
    parentNode: null,
    get firstChild() { return this.childNodes[0] ?? null },
    appendChild(child) {
      child.parentNode = this
      this.childNodes.push(child)
      return child
    },
    insertBefore(child, reference) {
      const index = reference === null ? this.childNodes.length : this.childNodes.indexOf(reference)
      child.parentNode = this
      this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child)
      return child
    },
    removeChild(child) {
      const index = this.childNodes.indexOf(child)
      if (index >= 0) this.childNodes.splice(index, 1)
      child.parentNode = null
      return child
    },
    replaceChild(next, previous) {
      const index = this.childNodes.indexOf(previous)
      if (index >= 0) {
        this.childNodes[index] = next
        next.parentNode = this
        previous.parentNode = null
      }
      return previous
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value)
      if (name === 'class') this.className = String(value)
      if (name === 'value') this.value = String(value)
      if (name === 'checked') this.checked = true
      if (name === 'disabled') this.disabled = true
    },
    removeAttribute(name) {
      delete this.attributes[name]
      if (name === 'value') this.value = ''
    },
    addEventListener(type, fn) {
      ;(this.listeners[type] ||= []).push(fn)
    },
    removeEventListener(type, fn) {
      const list = this.listeners[type] || []
      const index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    },
    set innerHTML(value) {
      if (String(value) !== '') throw new Error('stub innerHTML only supports clearing')
      this.childNodes = []
    },
    get innerHTML() {
      return ''
    },
    set textContent(value) {
      this.childNodes = []
      if (value !== '') this.appendChild(makeText(String(value)))
    },
    get textContent() {
      return this.childNodes.map((child) => child.textContent).join('')
    },
  }
  return el
}

export function textOf(node) {
  if (node === null || node === undefined) return ''
  if (node.nodeType === 3) return node.data
  return (node.childNodes ?? []).map(textOf).join('')
}

export function walk(node, visit) {
  visit(node)
  for (const child of node.childNodes ?? []) walk(child, visit)
}

/**
 * Build one fake page whose `#root` is the runtime mount point.
 * @returns {{ window: object, document: object, parent: object, root: object, posted: object[], dispatch: Function, onPost: ((message: object) => void) | null }}
 */
export function createPage() {
  const root = makeElement('div')
  const posted = []
  const listeners = []
  const page = {
    root,
    posted,
    onPost: null,
    window: {
      addEventListener(type, fn) {
        if (type === 'message') listeners.push(fn)
      },
      removeEventListener() {},
      postMessage() {},
    },
    document: {
      documentElement: { style: { setProperty() {} } },
      getElementById: (id) => (id === 'root' ? root : null),
      createElement: (tag) => makeElement(tag),
      createTextNode: (text) => makeText(text),
    },
    parent: {
      postMessage(message) {
        posted.push(message)
        if (typeof page.onPost === 'function') page.onPost(message)
      },
    },
    dispatch(message) {
      for (const listener of listeners) listener({ data: { __we: 1, ...message } })
    },
  }
  return page
}

/**
 * Locate the first element whose own text matches `text`.
 * @param {object} root - page root.
 * @param {string} text - exact text content of the element.
 * @returns {object | null} the element, or null.
 */
export function findByText(root, text) {
  let found = null
  walk(root, (node) => {
    if (found !== null) return
    if (node.nodeType === 1 && textOf(node) === text) found = node
  })
  return found
}
