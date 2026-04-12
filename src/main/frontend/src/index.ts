import { Planner } from './planner';

/**
 * Entry point.
 * Finds all .circular-planner-container elements on the page and initialises a Planner for each.
 * Called once the DOM is ready.
 */
function init(): void {
  const containers = document.querySelectorAll<HTMLElement>('.circular-planner-container');
  containers.forEach(container => {
    try {
      new Planner(container);
    } catch (e) {
      console.error('CircularPlanner: failed to initialise', container, e);
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
