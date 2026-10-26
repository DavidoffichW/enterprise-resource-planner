# Third-Party Notices

Enterprise Resource Planner includes or builds with the following principal open-source packages. Exact direct and transitive versions are recorded in `package-lock.json`.

| Package | Use | License |
| --- | --- | --- |
| React and React DOM | Browser UI rendering | MIT |
| AG Grid Community and AG Grid React | Editable planning grid | MIT |
| fflate | Bounded ZIP inspection and decompression | MIT |
| read-excel-file | Browser XLSX import | MIT |
| write-excel-file | Browser XLSX export | MIT |
| TypeScript | Development compiler | Apache-2.0 |
| Vite and `@vitejs/plugin-react` | Development and static build tooling | MIT |
| GitHub-maintained Pages actions | Manual release-build and deployment automation | MIT |

The locked dependency license audit also includes permissive Apache-2.0, BSD-3-Clause, ISC, MIT, and MPL-2.0 packages. MPL-2.0 entries are Lightning CSS build-tool binaries; they are not application source authored by this project. Upstream copyright and license files in the resolved packages remain controlling.

The Pages workflow pins `actions/checkout`, `actions/setup-node`, `actions/configure-pages`, `actions/upload-pages-artifact`, and `actions/deploy-pages` to reviewed commit identities. Those actions execute on GitHub-hosted automation and are not bundled into ERP's browser runtime.

## MIT License text

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Other license texts

Apache-2.0: <https://www.apache.org/licenses/LICENSE-2.0>

BSD-3-Clause: <https://opensource.org/license/bsd-3-clause>

ISC: <https://opensource.org/license/isc-license-txt>

MPL-2.0: <https://www.mozilla.org/MPL/2.0/>

This notice is a redistribution aid, not a project license. ERP itself has no selected public license at this time and is not approved for public release.
