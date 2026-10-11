import { useCallback, useEffect, useImperativeHandle, useRef, Ref } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';

import { decodeMenuMessage, encodeMenuMessage, MenuHostMessage, MenuMode, MenuWebMessage } from '../bridge/menuProtocol';
import { REPLAYS } from '../data/replays';
import { loadLogos } from '../menu/logos';
import { menuWorlds } from '../menu/worlds';
import { MENU_HTML } from '../webview/menuHtml';

export interface MenuStageApi {
  enter(id: string): void;
}

interface Props {
  mode: MenuMode;
  selectedId: string | null;
  onTapWorld?: (id: string) => void;
  onSwipe?: (dir: 1 | -1) => void;
  stageRef?: Ref<MenuStageApi>;
}

/**
 * The 3D menu background: ONE WebView shared by the home and world-selection screens (so moving
 * between them is a camera move, not a reload). It is unmounted while a replay is being played,
 * so there is never more than one 3D scene running.
 */
export function MenuStage({ mode, selectedId, onTapWorld, onSwipe, stageRef }: Props) {
  const web = useRef<WebView>(null);
  const seq = useRef(0);
  const ready = useRef(false);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  const latest = useRef({ mode, selectedId });
  latest.current = { mode, selectedId };

  const send = useCallback((msg: MenuHostMessage) => {
    web.current?.postMessage(encodeMenuMessage(seq.current++, msg));
  }, []);

  useImperativeHandle(stageRef, () => ({ enter: (id) => send({ type: 'ENTER', id }) }), [send]);

  useEffect(() => {
    if (ready.current) send({ type: 'MODE', mode });
  }, [mode, send]);
  useEffect(() => {
    if (ready.current) send({ type: 'SELECT', id: selectedId });
  }, [selectedId, send]);

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      const m: MenuWebMessage | null = decodeMenuMessage(e.nativeEvent.data);
      if (!m) return;
      if (m.type === 'READY') {
        ready.current = true;
        send({ type: 'INIT', worlds: menuWorlds(), mode: latest.current.mode });
        if (latest.current.selectedId) send({ type: 'SELECT', id: latest.current.selectedId });
        void loadLogos(REPLAYS, (id, dataUri) => alive.current && send({ type: 'LOGO', id, dataUri }), () => alive.current);
      } else if (m.type === 'WORLD_TAPPED') onTapWorld?.(m.id);
      else if (m.type === 'SWIPE') onSwipe?.(m.dir);
      else if (m.type === 'ERROR') console.warn('[menu scene]', m.message);
    },
    [send, onTapWorld, onSwipe],
  );

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="auto">
      <WebView
        ref={web}
        style={styles.web}
        originWhitelist={['*']}
        source={{ html: MENU_HTML }}
        onMessage={onMessage}
        javaScriptEnabled
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        androidLayerType="hardware"
        setSupportMultipleWindows={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  web: { flex: 1, backgroundColor: '#8fd6ff' },
});
