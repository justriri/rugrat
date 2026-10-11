import { ReactNode, useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import { mono } from '../theme';

type Variant = 'green' | 'gold' | 'wood' | 'red';
const FACE: Record<Variant, { face: string; edge: string; text: string }> = {
  green: { face: '#5be06c', edge: '#2d8a3a', text: '#0c1118' },
  gold: { face: '#ffd04a', edge: '#b8861a', text: '#0c1118' },
  wood: { face: '#a8743c', edge: '#5a3a1c', text: '#fff4dc' },
  red: { face: '#ef5a4f', edge: '#9c2a24', text: '#fff4dc' },
};

interface Props {
  label: string;
  onPress: () => void;
  variant?: Variant;
  /** Height of the face in px. */
  height?: number;
  fontSize?: number;
  icon?: ReactNode;
  /** A gentle "press me" breathing. */
  pulse?: boolean;
  disabled?: boolean;
  style?: object;
  accessibilityLabel?: string;
}

/** A chunky game button: a face that sinks into its base when pressed, with a little squash. */
export function GameButton({ label, onPress, variant = 'green', height = 56, fontSize = 18, icon, pulse, disabled, style, accessibilityLabel }: Props) {
  const c = FACE[variant];
  const depth = Math.max(4, Math.round(height * 0.12));
  const press = useRef(new Animated.Value(0)).current;
  const breathe = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!pulse) return;
    const loop = Animated.loop(Animated.sequence([Animated.timing(breathe, { toValue: 1, duration: 900, useNativeDriver: true }), Animated.timing(breathe, { toValue: 0, duration: 900, useNativeDriver: true })]));
    loop.start();
    return () => loop.stop();
  }, [pulse, breathe]);

  const down = () => Animated.spring(press, { toValue: 1, speed: 60, bounciness: 0, useNativeDriver: true }).start();
  const up = () => Animated.spring(press, { toValue: 0, speed: 24, bounciness: 14, useNativeDriver: true }).start();

  const scale = Animated.multiply(press.interpolate({ inputRange: [0, 1], outputRange: [1, 0.97] }), breathe.interpolate({ inputRange: [0, 1], outputRange: [1, 1.035] }));
  const sink = press.interpolate({ inputRange: [0, 1], outputRange: [0, depth - 1] });

  return (
    <Pressable onPress={onPress} onPressIn={down} onPressOut={up} disabled={disabled} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} style={style}>
      <Animated.View style={{ transform: [{ scale }], opacity: disabled ? 0.5 : 1 }}>
        <View style={[styles.base, { height: height + depth, backgroundColor: c.edge }]}>
          <Animated.View style={[styles.face, { height, backgroundColor: c.face, transform: [{ translateY: sink }] }]}>
            <View style={[styles.shine, { backgroundColor: 'rgba(255,255,255,0.28)' }]} />
            {icon}
            <Text style={[styles.label, { color: c.text, fontSize }]} numberOfLines={1}>
              {label}
            </Text>
          </Animated.View>
        </View>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { borderRadius: 10, justifyContent: 'flex-start' },
  face: { borderRadius: 10, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, overflow: 'hidden', borderWidth: 3, borderColor: 'rgba(12,17,24,0.85)' },
  shine: { position: 'absolute', left: 6, right: 6, top: 4, height: 5, borderRadius: 3 },
  label: { fontFamily: mono, fontWeight: '900', letterSpacing: 3, textShadowColor: 'rgba(255,255,255,0.25)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 0 },
});
