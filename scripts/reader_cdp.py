#!/usr/bin/env python3
"""Small resilient Chrome DevTools client for Reader AI Android WebView audits.

Android WebView can replace its debuggable target during cold navigation. A raw
websocket opened before that navigation then closes even though the app itself is
healthy. This helper rediscovers the Reader target and reconnects within the
caller's deadline; assertions and Runtime.evaluate errors still fail normally.
"""
import json
import time

import requests
import websocket


_TRANSIENT = (
    websocket.WebSocketConnectionClosedException,
    websocket.WebSocketTimeoutException,
    ConnectionError,
    BrokenPipeError,
    ConnectionResetError,
    OSError,
)


class ReaderCDP:
    def __init__(self, endpoint='http://127.0.0.1:9222', connect_timeout=25):
        self.endpoint = endpoint.rstrip('/')
        self.connect_timeout = connect_timeout
        self.ws = None
        self.seq = 0
        self.target_url = ''

    def close(self):
        old, self.ws = self.ws, None
        if old is not None:
            try:
                old.close()
            except Exception:
                pass

    def _pages(self):
        response = requests.get(self.endpoint + '/json/list', timeout=2)
        response.raise_for_status()
        data = response.json()
        return data if isinstance(data, list) else []

    def _choose_page(self, pages):
        live = [p for p in pages if p.get('webSocketDebuggerUrl')]
        if not live:
            return None
        # Prefer the actual APK-served Reader document. During WebView cold
        # navigation it may briefly be about:blank; that target is acceptable
        # as a fallback because a subsequent disconnect will be rediscovered.
        for page in live:
            if 'appassets.androidplatform.net' in str(page.get('url', '')):
                return page
        for page in live:
            if page.get('type') == 'page':
                return page
        return live[0]

    def connect(self, deadline=None):
        self.close()
        end = deadline if deadline is not None else time.time() + self.connect_timeout
        last = None
        while time.time() < end:
            try:
                page = self._choose_page(self._pages())
                if not page:
                    raise RuntimeError('no debuggable WebView target yet')
                remaining = max(1.0, min(self.connect_timeout, end - time.time()))
                self.ws = websocket.create_connection(
                    page['webSocketDebuggerUrl'],
                    timeout=remaining,
                    suppress_origin=True,
                )
                self.target_url = str(page.get('url', ''))
                self.seq = 0
                self._call_once('Runtime.enable', {})
                return self
            except Exception as exc:
                last = exc
                self.close()
                time.sleep(.2)
        raise RuntimeError(f'could not connect to Reader WebView before deadline: {last!r}')

    def _call_once(self, method, params):
        if self.ws is None:
            raise websocket.WebSocketConnectionClosedException('not connected')
        self.seq += 1
        ident = self.seq
        self.ws.send(json.dumps({'id': ident, 'method': method, 'params': params or {}}))
        while True:
            raw = self.ws.recv()
            if not raw:
                raise websocket.WebSocketConnectionClosedException('empty DevTools frame')
            msg = json.loads(raw)
            if msg.get('id') != ident:
                continue
            if 'error' in msg:
                raise RuntimeError(msg['error'])
            return msg.get('result', {})

    def call(self, method, params=None, timeout=30):
        end = time.time() + timeout
        last = None
        while time.time() < end:
            if self.ws is None:
                self.connect(end)
            try:
                return self._call_once(method, params or {})
            except _TRANSIENT as exc:
                last = exc
                self.close()
                time.sleep(.15)
                continue
        raise RuntimeError(f'CDP transport did not recover for {method}: {last!r}')

    def eval(self, code, timeout=30):
        result = self.call('Runtime.evaluate', {
            'expression': code,
            'awaitPromise': True,
            'returnByValue': True,
            'userGesture': True,
        }, timeout=timeout)
        if result.get('exceptionDetails'):
            raise RuntimeError(str(result['exceptionDetails']))
        return result.get('result', {}).get('value')

    def wait(self, code, timeout=60, delay=.3):
        end = time.time() + timeout
        last = None
        last_transport = None
        while time.time() < end:
            try:
                # Keep individual evaluate attempts short enough that a stale
                # target cannot consume the entire predicate deadline.
                last = self.eval(code, timeout=max(2, min(8, end - time.time())))
                if last:
                    return last
            except RuntimeError as exc:
                # Only transport recovery errors are retried here. JavaScript
                # exceptionDetails and protocol errors are deterministic bugs.
                text = str(exc)
                if 'CDP transport did not recover' not in text and 'could not connect to Reader WebView' not in text:
                    raise
                last_transport = exc
                self.close()
            time.sleep(delay)
        suffix = f'; transport={last_transport!r}' if last_transport else ''
        raise RuntimeError(f'timeout: {code}; last={last!r}{suffix}')
