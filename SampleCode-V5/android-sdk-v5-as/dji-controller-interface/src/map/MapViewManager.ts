import { MapLibreEngine } from './MapLibreEngine';
import type { MapEngine, MapProvider, MapViewManagerOptions, MapViewState } from './types';

export class MapViewManager {
  private engine: MapEngine | null = null;
  private readonly options: MapViewManagerOptions;

  constructor(options: MapViewManagerOptions) {
    this.options = options;
  }

  initialize(container: HTMLDivElement): void {
    this.engine = this.createEngine(this.options.provider);
    this.engine.initialize(container, {
      onReady: this.options.onReady,
      onClick: this.options.onClick,
      onInteraction: this.options.onInteraction,
    });
  }

  updateState(state: MapViewState): void {
    this.engine?.updateState(state);
  }

  recenter(): void {
    this.engine?.recenter();
  }

  destroy(): void {
    this.engine?.destroy();
    this.engine = null;
  }

  private createEngine(provider: MapProvider): MapEngine {
    switch (provider) {
      case 'maplibre':
      default:
        return new MapLibreEngine();
    }
  }
}
