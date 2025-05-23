
import { LlmChunkContent, LlmChunkTool } from '../../src/types/llm'
import { vi, beforeEach, expect, test } from 'vitest'
import { Plugin1, Plugin2, Plugin3 } from '../mocks/plugins'
import Message from '../../src/models/message'
import Attachment from '../../src/models/attachment'
import MistralAI from '../../src/providers/mistralai'
import { Mistral } from '@mistralai/mistralai'
import { CompletionEvent } from '@mistralai/mistralai/models/components'
import { loadMistralAIModels, loadModels } from '../../src/llm'
import { EngineCreateOpts } from '../../src/types/index'
import { LlmStreamingContextTools } from '../../src/engine'

Plugin2.prototype.execute = vi.fn((): Promise<string> => Promise.resolve('result2'))

vi.mock('@mistralai/mistralai', async() => {
  const Mistral = vi.fn()
  Mistral.prototype.options$ = {
    apiKey: '123'
  }
  Mistral.prototype.models = {
    list: vi.fn(() => {
      return { data: [
        { id: 'model2', name: 'model2' },
        { id: 'model1', name: 'model1' },
      ] }
    })
  }
  Mistral.prototype.chat = {
    complete: vi.fn(() => {
      return { choices: [ { message: { content: 'response' } } ] }
    }),
    stream: vi.fn(() => {
      return { 
        async * [Symbol.asyncIterator]() {
          
          // first we yield tool call chunks
          yield { data: { choices: [{ delta: { toolCalls: [ { id: 1, function: { name: 'plugin2', arguments: '[ "ar' }} ] }, finishReason: 'none' } ] } }
          yield { data: { choices: [{ delta: { toolCalls: [ { function: { arguments: [ 'g" ]' ] } }] }, finishReason: 'tool_calls' } ] } }
          
          // now the text response
          const content = 'response'
          for (let i = 0; i < content.length; i++) {
            yield { data: { choices: [{ delta: { content: content[i], }, finishReason: 'none' }] } }
          }
          yield { data: { choices: [{ delta: { content: '' }, finishReason: 'done' }] } }
        },
        controller: {
          abort: vi.fn()
        }
      }
    })
  }
  return { Mistral }
})

let config: EngineCreateOpts = {}
beforeEach(() => {
  vi.clearAllMocks();
  config = {
    apiKey: '123',
  }
})

test('MistralAI Load Models', async () => {
  const models = await loadMistralAIModels(config)
  expect(models.chat).toStrictEqual([
    { id: 'model1', name: 'model1', meta: { id: 'model1', name: 'model1' }, },
    { id: 'model2', name: 'model2', meta: { id: 'model2', name: 'model2' }, },
  ])
  expect(await loadModels('mistralai', config)).toStrictEqual(models)
})

test('MistralAI Basic', async () => {
  const mistralai = new MistralAI(config)
  expect(mistralai.getName()).toBe('mistralai')
})

test('MistralAI Vision Models', async () => {
  const mistralai = new MistralAI(config)
  expect(mistralai.isVisionModel('mistral-medium')).toBe(false)
  expect(mistralai.isVisionModel('mistral-large')).toBe(false)
})

test('MistralAI buildPayload', async () => {
  const mistralai = new MistralAI(config)
  const message = new Message('user', 'text')
  message.attach(new Attachment('image', 'image/png'))
  const payload = mistralai.buildPayload('mistral-large', [ message ])
  expect(payload).toStrictEqual([{ role: 'user', content: 'text' }])
})

test('MistralAI  completion', async () => {
  const mistralai = new MistralAI(config)
  const response = await mistralai.complete('model', [
    new Message('system', 'instruction'),
    new Message('user', 'prompt'),
  ], { temperature: 0.8 })
  expect(Mistral.prototype.chat.complete).toHaveBeenCalledWith({
    model: 'model',
    messages: [
      { role: 'system', content: 'instruction' },
      { role: 'user', content: 'prompt' }
    ],
    temperature : 0.8
  })
  expect(response).toStrictEqual({
    type: 'text',
    content: 'response'
  })
})

test('MistralAI nativeChunkToLlmChunk Text', async () => {
  const mistralai = new MistralAI(config)
  const streamChunk: CompletionEvent = { data: {
    id: '1', model: '',
    choices: [{
      index: 0, delta: { content: 'response' }, finishReason: null
    }],
  }}
  const context: LlmStreamingContextTools = {
    model: 'model',
    thread: [],
    opts: {},
    toolCalls: [],
  }
  for await (const llmChunk of mistralai.nativeChunkToLlmChunk(streamChunk, context)) {
    expect(llmChunk).toStrictEqual({ type: 'content', text: 'response', done: false })
  }
  streamChunk.data.choices[0].delta.content = null
  streamChunk.data.choices[0].finishReason = 'stop'
  for await (const llmChunk of mistralai.nativeChunkToLlmChunk(streamChunk, context)) {
    expect(llmChunk).toStrictEqual({ type: 'content', text: '', done: true })
  }
})

test('MistralAI stream with tools', async () => {
  const mistralai = new MistralAI(config)
  mistralai.addPlugin(new Plugin1())
  mistralai.addPlugin(new Plugin2())
  mistralai.addPlugin(new Plugin3())
  const { stream, context } = await mistralai.stream('mistral-large', [
    new Message('system', 'instruction'),
    new Message('user', 'prompt'),
  ], { top_k: 4 })
  expect(Mistral.prototype.chat.stream).toHaveBeenNthCalledWith(1, {
    model: 'mistral-large',
    messages: [
      { role: 'system', content: 'instruction' }, 
      { role: 'user', content: 'prompt' }
    ],
    toolChoice: 'auto',
    tools: expect.any(Array),
  })
  expect(stream.controller).toBeDefined()
  let response = ''
  let lastMsg: LlmChunkContent|null = null
  const toolCalls: LlmChunkTool[] = []
  for await (const chunk of stream) {
    for await (const msg of mistralai.nativeChunkToLlmChunk(chunk, context)) {
      lastMsg = msg
      if (msg.type === 'content') response += msg.text
      if (msg.type === 'tool') toolCalls.push(msg)
    }
  }
  expect(Mistral.prototype.chat.stream).toHaveBeenNthCalledWith(2, {
    model: 'mistral-large',
    messages: [
      { role: 'system', content: 'instruction' }, 
      { role: 'user', content: 'prompt' },
      { role: 'assistant', toolCalls: [ { id: 1, function: { name: 'plugin2', arguments: '[ "arg" ]' } } ] },
      { role: 'tool', toolCallId: 1, name: 'plugin2', content: '"result2"' }
    ],
    toolChoice: 'auto',
    tools: expect.any(Array),
  })
  expect(lastMsg?.done).toBe(true)
  expect(response).toBe('response')
  expect(Plugin2.prototype.execute).toHaveBeenCalledWith(['arg'])
  expect(toolCalls[0]).toStrictEqual({ type: 'tool', name: 'plugin2', status: 'prep2', done: false })
  expect(toolCalls[1]).toStrictEqual({ type: 'tool', name: 'plugin2', status: 'run2', done: false })
  expect(toolCalls[2]).toStrictEqual({ type: 'tool', name: 'plugin2', call: { params: ['arg'], result: 'result2' }, done: true })
  await mistralai.stop()
  //expect(Mistral.prototype.abort).toHaveBeenCalled()
})

test('MistralAI stream without tools', async () => {
  const mistralai = new MistralAI(config)
  mistralai.addPlugin(new Plugin1())
  mistralai.addPlugin(new Plugin2())
  mistralai.addPlugin(new Plugin3())
  const { stream } = await mistralai.stream('model', [
    new Message('system', 'instruction'),
    new Message('user', 'prompt'),
  ], { top_p: 4 })
  expect(Mistral.prototype.chat.stream).toHaveBeenCalledWith({
    model: 'model',
    messages: [ { role: 'system', content: 'instruction' }, { role: 'user', content: 'prompt' } ],
    topP: 4,
  })
  expect(stream).toBeDefined()
})

test('MistralAI  stream without tools', async () => {
  const mistralai = new MistralAI(config)
  const { stream } = await mistralai.stream('mistral-large', [
    new Message('system', 'instruction'),
    new Message('user', 'prompt'),
  ])
  expect(Mistral.prototype.chat.stream).toHaveBeenCalledWith({
    model: 'mistral-large',
    messages: [ { role: 'system', content: 'instruction' }, { role: 'user', content: 'prompt' } ],
  })
  expect(stream).toBeDefined()
})
