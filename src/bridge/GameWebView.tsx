import { Ref, useCallback, useImperativeHandle, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';

import { GAME_HTML } from '../webview/gameHtml';
import { decodeWebMessage, encodeHostMessage, HostMessage, WebMessage } from './protocol';

export interface GameBridge {
  send(msg: HostMessage): void;
}

interface Props {
  bridgeRef: Ref<GameBridge>;
  onMessage: (msg: WebMessage) => void;
}

/** Hosts the Three.js scene. All traffic goes through the typed protocol in ./protocol. */
export function GameWebView({ bridgeRef, onMessage }: Props) {
  const webRef = useRef<WebView>(null);
  const seq = useRef(0);

  useImperativeHandle(
    bridgeRef,
    () => ({
      send(msg) {
        webRef.current?.postMessage(encodeHostMessage(seq.current++, msg));
      },
    }),
    [],
  );

  const handle = useCallback(
    (event: WebViewMessageEvent) => {
      const msg = decodeWebMessage(event.nativeEvent.data);
      if (msg) onMessage(msg);
    },
    [onMessage],
  );

  return (
    <WebView
      ref={webRef}
      style={styles.web}
      originWhitelist={['*']}
      source={{ html: GAME_HTML }}
      onMessage={handle}
      javaScriptEnabled
      scrollEnabled={false}
      bounces={false}
      overScrollMode="never"
      androidLayerType="hardware"
      setSupportMultipleWindows={false}
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
    />
  );
}

const styles = StyleSheet.create({
  web: { flex: 1, backgroundColor: '#8fd6ff' },
});
