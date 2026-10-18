import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexSessionStore } from '../src/codexSessions.js';

const firstImage = Buffer.from('first-phone-image');
const secondImage = Buffer.from('second-phone-image');

function inputImage(bytes) {
  return { type: 'input_image', image_url: `data:image/png;base64,${bytes.toString('base64')}` };
}

function wrappedImage(imagePath, bytes, number = 1) {
  return [
    { type: 'input_text', text: `<image name=[Image #${number}] path=${JSON.stringify(imagePath)}>` },
    inputImage(bytes),
    { type: 'input_text', text: '</image>' }
  ];
}

async function fixture(t) {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-image-projection-'));
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }));
  const mobileImagesDir = path.join(codexHome, 'mobile-images');
  await fs.mkdir(mobileImagesDir);
  const firstPath = path.join(mobileImagesDir, 'phone one.png').replace(/\\/g, '/');
  const secondPath = path.join(mobileImagesDir, 'phone-two.png').replace(/\\/g, '/');
  await fs.writeFile(firstPath, firstImage);
  await fs.writeFile(secondPath, secondImage);
  const sessionId = 'image-projection-fixture';
  const sessionDir = path.join(codexHome, 'sessions', '2026', '10', '15');
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), JSON.stringify({
    id: sessionId, thread_name: 'Image projection fixture', updated_at: '2026-10-15T00:00:00Z'
  }) + '\n');
  return {
    firstPath, secondPath, mobileImagesDir,
    async project(content, role = 'user', includeEvent = false) {
      const records = [{
        timestamp: '2026-10-15T00:00:01Z', type: 'response_item',
        payload: { type: 'message', role, content }
      }];
      if (includeEvent) {
        const event = {
          timestamp: '2026-10-15T00:00:01Z', type: 'event_msg',
          payload: { type: 'user_message', message: content[0].text }
        };
        if (includeEvent === 'before') records.unshift(event);
        else records.push(event);
      }
      await fs.writeFile(path.join(sessionDir, `rollout-2026-10-15T00-00-00-${sessionId}.jsonl`), records.map(record => JSON.stringify(record)).join('\n') + '\n');
      const detail = await new CodexSessionStore({ codexHome, mobileImagesDir }).getSession(sessionId);
      assert.equal(detail.entries.length, 1);
      return detail.entries[0].text;
    }
  };
}

function imageTargets(text) {
  return [...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1]);
}

test('image projection shows one phone attachment for its linked official input_image', async t => {
  const f = await fixture(t);
  const text = await f.project([
    { type: 'input_text', text: `Check this picture\n![手机端图片](${f.firstPath})` },
    ...wrappedImage(f.firstPath.replace(/\//g, path.sep), firstImage)
  ]);
  assert.deepEqual(imageTargets(text), [f.firstPath]);
  assert.match(text, /Check this picture/);
  assert.doesNotMatch(text, /<image|<\/image>/);
  assert.deepEqual((await fs.readdir(f.mobileImagesDir)).sort(), ['phone one.png', 'phone-two.png']);
});

test('image projection retains two different linked phone attachments', async t => {
  const f = await fixture(t);
  const text = await f.project([
    { type: 'input_text', text: `![手机端图片](${f.firstPath})\n![手机端图片](${f.secondPath})` },
    ...wrappedImage(f.firstPath, firstImage),
    ...wrappedImage(f.secondPath, secondImage, 2)
  ]);
  assert.deepEqual(imageTargets(text), [f.firstPath, f.secondPath]);
});

test('image projection replaces an unavailable linked local reference with official image bytes', async t => {
  const f = await fixture(t);
  await fs.unlink(f.firstPath);
  const text = await f.project([
    { type: 'input_text', text: `![手机端图片](${f.firstPath})` },
    ...wrappedImage(f.firstPath, firstImage)
  ]);
  const targets = imageTargets(text);
  assert.equal(targets.length, 1);
  assert.notEqual(targets[0], f.firstPath);
  assert.deepEqual(await fs.readFile(targets[0]), firstImage);
});

test('image projection merges the original event after replacing an unavailable local reference', async t => {
  const f = await fixture(t);
  await fs.unlink(f.firstPath);
  for (const eventPosition of ['before', 'after']) {
    const text = await f.project([
      { type: 'input_text', text: `![手机端图片](${f.firstPath})` },
      ...wrappedImage(f.firstPath, firstImage)
    ], 'user', eventPosition);
    const targets = imageTargets(text);
    assert.equal(targets.length, 1);
    assert.deepEqual(await fs.readFile(targets[0]), firstImage);
  }
});

test('image projection retains distinct paths even when their image bytes are identical', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.secondPath, firstImage);
  const text = await f.project([
    { type: 'input_text', text: `![手机端图片](${f.firstPath})\n![手机端图片](${f.secondPath})` },
    ...wrappedImage(f.firstPath, firstImage),
    ...wrappedImage(f.secondPath, firstImage, 2)
  ]);
  assert.deepEqual(imageTargets(text), [f.firstPath, f.secondPath]);
});

test('image projection preserves an independent desktop image alongside a phone attachment', async t => {
  const f = await fixture(t);
  const text = await f.project([
    { type: 'input_text', text: `![手机端图片](${f.firstPath})` },
    ...wrappedImage(f.firstPath, firstImage),
    inputImage(secondImage)
  ]);
  const targets = imageTargets(text);
  assert.equal(targets.length, 2);
  assert.equal(targets[0], f.firstPath);
  assert.deepEqual(await fs.readFile(targets[1]), secondImage);
});

test('image projection does not pair different paths or incomplete image wrappers', async t => {
  const f = await fixture(t);
  for (const images of [
    wrappedImage(f.secondPath, secondImage),
    wrappedImage(f.firstPath, secondImage).slice(0, 2)
  ]) {
    const text = await f.project([
      { type: 'input_text', text: `![手机端图片](${f.firstPath})` }, ...images
    ]);
    const targets = imageTargets(text);
    assert.equal(targets.length, 2);
    assert.equal(targets[0], f.firstPath);
    assert.deepEqual(await fs.readFile(targets[1]), secondImage);
  }
});

test('image projection preserves assistant output_image and its separate markdown', async t => {
  const f = await fixture(t);
  const text = await f.project([
    { type: 'output_text', text: `![Result](${f.firstPath})` },
    { ...inputImage(secondImage), type: 'output_image' }
  ], 'assistant');
  const targets = imageTargets(text);
  assert.equal(targets.length, 2);
  assert.deepEqual(await fs.readFile(targets[0]), firstImage);
  assert.deepEqual(await fs.readFile(targets[1]), secondImage);
});

test('image projection leaves unavailable local references intact when official pixels cannot be decoded', async t => {
  const f = await fixture(t);
  await fs.unlink(f.firstPath);
  const text = await f.project([
    { type: 'input_text', text: `![手机端图片](${f.firstPath})` },
    ...wrappedImage(f.firstPath, Buffer.alloc(0))
  ]);
  assert.deepEqual(imageTargets(text), [f.firstPath]);
});
