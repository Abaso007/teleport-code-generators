import { Mapping } from '@teleporthq/teleport-types'

export const ReactProjectMapping: Mapping = {
  elements: {
    navlink: {
      elementType: 'Link',
      dependency: {
        type: 'library',
        path: 'react-router-dom',
        version: '^5.2.0',
        meta: {
          namedImport: true,
        },
      },
      attrs: {
        to: { type: 'dynamic', content: { referenceType: 'attr', id: 'transitionTo' } },
      },
    },
    'cms-list-repeater': {
      elementType: 'Repeater',
      dependency: {
        type: 'package',
        path: '@teleporthq/react-components',
        version: 'latest',
        meta: {
          namedImport: true,
        },
      },
    },
  },
}
