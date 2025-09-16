// Simple global z-index manager for panels
// Much more efficient than event dispatching
let globalZIndex = 50;

export const getNextZIndex = (): number => {
  return ++globalZIndex;
};

export const getBaseZIndex = (): number => {
  return 50;
};